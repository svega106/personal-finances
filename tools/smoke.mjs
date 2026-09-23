/**
 * Smoke test used to prove the module split changed nothing.
 *
 * Loads an app (file path or URL), seeds a fixed dataset into localStorage,
 * clicks through every view, and prints a JSON fingerprint: console errors,
 * page errors, and the visible text of each view.
 *
 * Run it against the original single-file app and against the split build; the
 * two fingerprints must be identical.
 *
 *   node tools/smoke.mjs <file-or-url> > baseline.json
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const target = process.argv[2];
if (!target) {
  console.error('usage: node tools/smoke.mjs <file-or-url>');
  process.exit(2);
}
const url = existsSync(target) ? pathToFileURL(target).href : target;

/** A fixed month so every run produces the same numbers. */
const SEED = {
  months: {
    '2026-09': {
      income: 1850000,
      extraIncome: [{ id: 'x1', name: 'Consulting', amount: 150000 }],
      bills: [
        { id: 'b1', name: 'Rent', amount: 450000 },
        { id: 'b2', name: 'Utilities', amount: 65000 },
      ],
      recurring: [
        { id: 'r1', name: 'Groceries', amount: 280000, cat: 'needs' },
        { id: 'r2', name: 'Streaming', amount: 18000, cat: 'wants' },
      ],
      oneTime: [{ id: 'o1', name: 'Padel racket', amount: 95000, cat: 'wants' }],
      contributions: { g1: 120000 },
      invest: 200000,
      usedCarryover: 0,
    },
    '2026-08': {
      income: 1850000,
      extraIncome: [],
      bills: [{ id: 'b1', name: 'Rent', amount: 450000 }],
      recurring: [],
      oneTime: [],
      contributions: {},
      invest: 150000,
      usedCarryover: 0,
    },
  },
  goals: [{ id: 'g1', name: 'Emergency fund', target: 3000000, saved: 850000 }],
  settings: { alloc: { needs: 50, wants: 30, savings: 20 }, name: 'Sebas' },
  lastSaved: 1758400000000,
};

const VIEWS = ['dashboard', 'plan', 'goals', 'annual', 'settings'];

// The container ships a pinned Chromium; never download another.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

// Seed before any app script runs.
//
// Both seeds are installed so one script fingerprints either build: the
// original single-file app reads localStorage, the split app reads an injected
// repository (which also makes it skip the sign-in gate).
await page.addInitScript((seed) => {
  try {
    window.localStorage.setItem('pfa.state.v1', JSON.stringify(seed));
  } catch (e) {
    /* ignore */
  }

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const store = {
    months: clone(seed.months),
    goals: clone(seed.goals),
    settings: clone(seed.settings),
  };
  store.accounts = clone(seed.accounts || []);
  store.rules = clone(seed.rules || []);
  store.transactions = clone(seed.transactions || []);
  store.snapshots = clone(seed.snapshots || []);
  let seq = 1;
  window.__REPO__ = {
    loadAll: async () => clone(store),
    saveBudget: async (month, data) => { store.months[month] = clone(data); },
    deleteBudget: async (month) => { delete store.months[month]; },
    saveGoals: async (goals) => { store.goals = clone(goals); },
    saveSettings: async (settings) => { store.settings = clone(settings); },
    listAccounts: async () => clone(store.accounts),
    listRules: async () => clone(store.rules),
    listFxRates: async () => clone(store.fxRates || []),
    // Kept in step with the real repo on purpose: a harness stub that is
    // missing a method fails as a hung selector, not as an error.
    listAccountBalances: async () => clone(store.accounts || []).map((a) => {
      const snaps = (store.snapshots || [])
        .filter((s) => s.accountId === a.id)
        .sort((x, y) => (x.asOf < y.asOf ? 1 : -1));
      const last = snaps[0] || null;
      const moved = (store.transactions || [])
        .filter((t) => t.status !== 'voided' && t.currency === a.currency
          && (t.accountId === a.id || t.counterpartyAccountId === a.id)
          && (!last || String(t.postedAt).slice(0, 10) > last.asOf))
        .reduce((sum, t) => {
          if (t.kind === 'income' || t.kind === 'adjustment') return sum + t.amount;
          if (t.kind === 'transfer') return t.counterpartyAccountId === a.id ? sum + t.amount : sum - t.amount;
          if (t.kind === 'expense') return sum - t.amount;
          return sum;
        }, 0);
      return {
        accountId: a.id, label: a.label, type: a.type, currency: a.currency,
        snapshotDate: last ? last.asOf : null,
        snapshotBalance: last ? last.balance : null,
        currentBalance: (last ? last.balance : 0) + moved,
        hasSnapshot: !!last, stale: last ? false : null, scope: a.scope || 'personal',
      };
    }),
    listSnapshots: async (accountId) => clone(store.snapshots || [])
      .filter((s) => s.accountId === accountId),
    saveSnapshot: async ({ accountId, asOf, balance, currency, note }) => {
      store.snapshots = store.snapshots || [];
      const at = store.snapshots.findIndex((s) => s.accountId === accountId && s.asOf === asOf);
      const row = { id: 'sn' + (seq++), accountId, asOf, balance, currency, note: note || null };
      if (at >= 0) { row.id = store.snapshots[at].id; store.snapshots[at] = row; }
      else store.snapshots.push(row);
    },
    deleteSnapshot: async (id) => {
      const at = (store.snapshots || []).findIndex((s) => s.id === id);
      if (at >= 0) store.snapshots.splice(at, 1);
    },
    upsertAccount: async (a) => {
      const row = clone(a);
      const at = row.id ? store.accounts.findIndex((x) => x.id === row.id) : -1;
      if (at >= 0) store.accounts[at] = row;
      else { row.id = row.id || ('ac' + (seq++)); store.accounts.push(row); }
      return clone(row);
    },
    archiveAccount: async (id) => {
      const at = store.accounts.findIndex((x) => x.id === id);
      if (at >= 0) store.accounts.splice(at, 1);
    },
    saveFxRate: async ({ month, currency, rate }) => {
      store.fxRates = store.fxRates || [];
      const at = store.fxRates.findIndex((x) => x.month === month && x.currency === currency);
      if (at >= 0) store.fxRates[at].rate = rate; else store.fxRates.push({ month, currency, rate });
    },
    listTransactions: async ({ from, to }) => clone(store.transactions)
      .filter((t) => t.postedAt >= from && t.postedAt < to)
      .sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1)),
    upsertTransaction: async (t) => {
      const row = clone(t);
      const at = store.transactions.findIndex(
        (x) => (row.id && x.id === row.id) || x.extId === row.extId);
      if (at >= 0) { row.id = store.transactions[at].id; store.transactions[at] = row; }
      else { row.id = row.id || ('tx' + seq++); store.transactions.push(row); }
      return clone(row);
    },
    deleteTransaction: async (id) => {
      const at = store.transactions.findIndex((x) => x.id === id);
      if (at >= 0) store.transactions.splice(at, 1);
    },
    _dump: () => clone(store),
  };
  // Freeze "now" so month defaults and any date-dependent copy stay put.
  const FIXED = new Date('2026-09-21T12:00:00-06:00').getTime();
  const RealDate = Date;
  // eslint-disable-next-line no-global-assign
  Date = class extends RealDate {
    constructor(...args) {
      return args.length ? new RealDate(...args) : new RealDate(FIXED);
    }
    static now() {
      return FIXED;
    }
  };
  Date.prototype = RealDate.prototype;
}, SEED);

await page.goto(url, { waitUntil: 'networkidle' });
// The split app boots asynchronously; the original is ready immediately.
await page.waitForFunction(() => typeof window.setView === 'function', null, { timeout: 10000 });
await page.waitForTimeout(400);

const result = { views: {}, consoleErrors, pageErrors };

for (const v of VIEWS) {
  await page.evaluate((view) => window.setView(view), v);
  await page.waitForTimeout(250);
  const text = await page.evaluate(() => {
    const el = document.getElementById('views');
    return (el ? el.innerText : '(no #views)')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n');
  });
  result.views[v] = text;
}

// A couple of interactions, to catch wiring that a static render would not.
await page.evaluate(() => window.setView('plan'));
await page.waitForTimeout(150);
// Reads through whichever store the build uses, so the number is comparable.
result.afterAddItem = await page.evaluate(async () => {
  window.addItem('oneTime');
  if (window.flush) await window.flush();
  // `window.flush` exists only on the repository-backed build; the original
  // app ignores the injected repo and writes localStorage.
  const m = window.flush
    ? window.__REPO__._dump()
    : JSON.parse(localStorage.getItem('pfa.state.v1'));
  return m.months['2026-09'].oneTime.length;
});
result.afterMonthShift = await page.evaluate(() => {
  window.render();
  return document.getElementById('monthSel')?.value ?? null;
});

await browser.close();
console.log(JSON.stringify(result, null, 2));
