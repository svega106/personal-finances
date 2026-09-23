/**
 * Drives the service worker for real: install, offline, and update.
 *
 * The point is not that the manifest parses — it is the failure mode a
 * service worker introduces. A worker that pins someone to an old build, or
 * that caches an auth response, is worse than having no worker at all. Both
 * are checked here, and the update check has already caught one real bug
 * (`cache.addAll` reading the browser's own HTTP cache and storing the
 * previous build's index.html).
 *
 *   node tools/pwa-check.mjs <url> <dist-dir>
 *
 * The dist directory is needed because proving an update works means
 * publishing one: the script edits the served files and puts them back.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2];
const DIST = process.argv[3];
if (!BASE || !DIST) {
  console.error('usage: node tools/pwa-check.mjs <url> <dist-dir>');
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
// A phone viewport, since this is what the feature is for.
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle' });

/* ------------------------------------------------------------- manifest */

const man = await page.evaluate(async () => {
  const href = document.querySelector('link[rel=manifest]')?.href;
  return href ? await (await fetch(href)).json() : null;
});
check('manifest is linked and parses', !!man);
check('has a name and short_name', !!man?.name && !!man?.short_name);
check('short_name fits under an icon', (man?.short_name || '').length <= 12, man?.short_name);
check('display is standalone', man?.display === 'standalone', man?.display);
check('start_url is set', !!man?.start_url, man?.start_url);
check('has a 192 and a 512 icon', ['192x192', '512x512'].every((s) => man?.icons?.some((i) => i.sizes === s)));
check('has a maskable icon', man?.icons?.some((i) => (i.purpose || '').includes('maskable')));

for (const ic of man?.icons ?? []) {
  const status = await page.evaluate(async (src) => (await fetch(src)).status, ic.src);
  check(`icon ${ic.sizes} ${ic.purpose || ''} is served`, status === 200, String(status));
}
const apple = await page.evaluate(async () => {
  const h = document.querySelector('link[rel="apple-touch-icon"]')?.href;
  return h ? (await fetch(h)).status : 0;
});
check('apple-touch-icon is served (iOS ignores the manifest)', apple === 200, String(apple));

/* --------------------------------------------------------- registration */

await page.waitForTimeout(2500);
const reg = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return { has: !!r, active: r?.active?.state, scope: r?.scope };
});
check('service worker registered', reg.has, JSON.stringify(reg));
check('worker is active', reg.active === 'activated', String(reg.active));
check('scope covers the whole app', (reg.scope || '').endsWith('/'), reg.scope);

/* ------------------------------------------------------- what is cached */

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const cached = await page.evaluate(async () => {
  const out = {};
  for (const n of await caches.keys()) {
    out[n] = (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname);
  }
  return out;
});
const all = Object.values(cached).flat();
check('exactly one cache, versioned', Object.keys(cached).length === 1, JSON.stringify(Object.keys(cached)));
check('the shell is cached', all.includes('/index.html'), JSON.stringify(all));
check('hashed assets are cached', all.some((p) => p.startsWith('/assets/')), JSON.stringify(all));
check('nothing auth- or data-shaped is cached',
  !all.some((p) => p.includes('/auth') || p.includes('/rest')), JSON.stringify(all));

/* ------------------------------------------------------------- offline */

await ctx.setOffline(true);
const status = await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  .then((r) => r?.status()).catch((e) => `threw: ${e.message}`);
const body = await page.evaluate(() => document.body.innerText.slice(0, 80));
check('the app loads with no network at all', status === 200, String(status));
check('it renders something rather than a blank page', body.trim().length > 0, JSON.stringify(body));
await ctx.setOffline(false);

/* -------------------------------------------------- a new deploy wins */

const swPath = join(DIST, 'sw.js');
const htmlPath = join(DIST, 'index.html');
const sw0 = readFileSync(swPath, 'utf8');
const html0 = readFileSync(htmlPath, 'utf8');

try {
  writeFileSync(swPath, sw0.replace("const VERSION = 'v1';", "const VERSION = 'v-test';"));
  writeFileSync(htmlPath, html0.replace('<body>', '<body><!--BUILD-2-->'));

  // Two visits: one to pick up the new worker, one under its control.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const after = await page.evaluate(async () => ({
    names: await caches.keys(),
    sawNewBuild: ((await (await caches.match('/index.html'))?.text()) || '').includes('BUILD-2'),
  }));
  check('the old cache is deleted on a version bump',
    after.names.length === 1 && after.names[0].includes('v-test'), JSON.stringify(after.names));
  check('the new build replaces the cached shell', after.sawNewBuild,
    'still serving the previous index.html — the stale-forever bug');
} finally {
  writeFileSync(swPath, sw0);
  writeFileSync(htmlPath, html0);
}

check('no page errors throughout', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
