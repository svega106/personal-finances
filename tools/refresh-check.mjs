/**
 * Does the screen change when the data does?
 *
 * The bug this exists to stop: three separate caches hold server data, a
 * transaction save dropped only one of them, and so adding a charge left the
 * Accounts view showing the balance it had before. Every unit test passed —
 * the write was correct, the ledger reloaded, the number on screen was stale.
 * Only a browser can see that.
 *
 * It also covers the refresh button, whose whole job is re-reading data
 * without the page reload that would throw you back to the dashboard.
 *
 *   node tools/refresh-check.mjs <url>
 */
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) { console.error('usage: node tools/refresh-check.mjs <url>'); process.exit(2); }

const ACCOUNTS = [
  { id: 's1', label: 'Ahorros ₡', type: 'savings', currency: 'CRC', scope: 'personal',
    issuer: 'bac', brand: 'mastercard', last4: '2207' },
  { id: 'c1', label: 'BAC VISA ₡', type: 'card', currency: 'CRC', scope: 'personal',
    issuer: 'bac', last4: '4477' },
];

const SEED = {
  months: { '2026-09': { income: 1850000, extraIncome: [], bills: [], recurring: [],
                         oneTime: [], contributions: {}, invest: 0, usedCarryover: 0 } },
  goals: [], settings: { alloc: { needs: 50, wants: 30, savings: 20 }, name: 'Sebas' },
  accounts: ACCOUNTS,
  transactions: [
    { id: 't1', extId: 'e1', kind: 'expense', postedAt: '2026-09-20T10:00:00-06:00',
      merchant: 'Auto Mercado', amount: 12000, currency: 'CRC', amountCrc: 12000,
      accountId: 's1', cat: 'needs', scope: 'personal', status: 'settled', reviewed: true },
  ],
};

const fails = [];
const results = {};
function check(name, ok, detail) {
  results[name] = ok ? 'PASS' : `FAIL${detail ? ' — ' + detail : ''}`;
  if (!ok) fails.push(name);
}

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

await page.addInitScript((seed) => {
  const c = (v) => JSON.parse(JSON.stringify(v));
  const store = c(seed);
  let seq = 100;
  // Counted so the test can tell a repaint from a genuine re-read.
  window.__calls = { balances: 0, accounts: 0, budget: 0, transactions: 0, work: 0 };
  const SNAPSHOT = 2450000;

  window.__REPO__ = {
    loadAll: async () => { window.__calls.budget += 1; return { months: c(store.months), goals: c(store.goals), settings: c(store.settings) }; },
    saveBudget: async () => {}, deleteBudget: async () => {},
    saveGoals: async () => {}, saveSettings: async () => {},
    listAccounts: async () => { window.__calls.accounts += 1; return c(store.accounts); },
    listRules: async () => [], listFxRates: async () => [], saveFxRate: async () => {},
    listTransactions: async ({ from, to }) => {
      window.__calls.transactions += 1;
      return c(store.transactions).filter((t) => t.postedAt >= from && t.postedAt < to);
    },
    listWorkCharges: async () => { window.__calls.work += 1; return []; },
    upsertTransaction: async (t) => {
      const row = { ...t, id: t.id || 'n' + (seq += 1) };
      const i = store.transactions.findIndex((x) => x.id === row.id);
      if (i >= 0) store.transactions[i] = row; else store.transactions.push(row);
      return c(row);
    },
    deleteTransaction: async (id) => {
      const i = store.transactions.findIndex((x) => x.id === id);
      if (i >= 0) store.transactions.splice(i, 1);
    },
    countTransactions: async (id) => store.transactions.filter((t) => t.accountId === id).length,
    // The real balances view derives a savings balance from its snapshot minus
    // everything spent since, in SQL. Modelled here so a new charge moves it.
    listAccountBalances: async () => {
      window.__calls.balances += 1;
      return store.accounts.map((a) => {
        const spent = store.transactions
          .filter((t) => t.accountId === a.id && t.currency === 'CRC' && t.scope !== 'work')
          .reduce((s, t) => s + t.amount, 0);
        const savings = a.type === 'savings';
        return {
          accountId: a.id, label: a.label, type: a.type, currency: a.currency,
          snapshotDate: savings ? '2026-09-01' : null,
          snapshotBalance: savings ? SNAPSHOT : null,
          currentBalance: savings ? SNAPSHOT - spent : -spent,
          hasSnapshot: savings, stale: null, scope: a.scope, pendingFx: 0,
        };
      });
    },
    listSnapshots: async () => [], saveSnapshot: async () => {}, deleteSnapshot: async () => {},
    upsertAccount: async (a) => a, archiveAccount: async () => {},
  };

  const FROZEN = new Date('2026-09-23T12:00:00-06:00').getTime();
  const Real = Date;
  Date = class extends Real {
    constructor(...a) { return a.length ? new Real(...a) : new Real(FROZEN); }
    static now() { return FROZEN; }
  };
  Date.prototype = Real.prototype;
}, SEED);

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.setView === 'function', null, { timeout: 15000 });

/** The sheet is hidden by a class; its markup stays in the DOM. */
const closed = () => page.waitForFunction(
  () => !document.getElementById('modalBg')?.classList.contains('show'),
  null, { timeout: 8000 });

const savedTotal = () => page.evaluate(() => {
  const card = [...document.querySelectorAll('.card')]
    .find((c) => /saved & cash/i.test(c.querySelector('h3')?.textContent || ''));
  return card?.querySelector('.stat')?.textContent?.trim() ?? null;
});

/* ---- 1. a new charge moves the Accounts view without a page reload ---- */

await page.evaluate(() => window.setView('accounts'));
await page.waitForFunction(() => /saved & cash/i.test(document.body.textContent), null, { timeout: 8000 });
const before = await savedTotal();
check('accounts view loads a balance', /[\d,]/.test(before || ''), `got ${before}`);

await page.evaluate(() => window.setView('transactions'));
await page.waitForFunction(() => document.querySelector('.tx-row') !== null, null, { timeout: 8000 });

await page.evaluate(() => window.txEdit());
await page.waitForSelector('#tx_name', { timeout: 5000 });
await page.fill('#tx_name', 'Gasolina');
await page.fill('#tx_amount', '9000');
await page.selectOption('#tx_account', 's1');
await page.click('#tx_save');
await closed();

const rowShown = await page.evaluate(() => document.body.textContent.includes('Gasolina'));
check('the new charge appears in the list straight away', rowShown);

const flashed = await page.evaluate(() => document.querySelectorAll('.tx-flash').length);
check('the new row is highlighted', flashed === 1, `${flashed} highlighted`);

await page.evaluate(() => window.setView('accounts'));
await page.waitForFunction(() => /saved & cash/i.test(document.body.textContent), null, { timeout: 8000 });
const after = await savedTotal();
check('the balance moved without a page reload', before !== after, `${before} then ${after}`);

const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));
check('it moved by the amount of the charge', num(before) - num(after) === 9000,
      `${num(before)} - ${num(after)} = ${num(before) - num(after)}`);

/* ---- 2. deleting it puts the balance back ---- */

await page.evaluate(() => window.setView('transactions'));
await page.waitForFunction(() => document.body.textContent.includes('Gasolina'), null, { timeout: 8000 });
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.tx-row')].find((r) => r.textContent.includes('Gasolina'));
  row.click();
});
await page.waitForSelector('#tx_name', { timeout: 5000 });
page.once('dialog', (d) => d.accept());
await page.evaluate(() => window.txDelete());
await page.waitForFunction(() => !document.body.textContent.includes('Gasolina'), null, { timeout: 8000 });

await page.evaluate(() => window.setView('accounts'));
await page.waitForFunction(() => /saved & cash/i.test(document.body.textContent), null, { timeout: 8000 });
check('deleting puts the balance back', (await savedTotal()) === before);

/* ---- 3. the refresh button ---- */

const btn = await page.$('#refreshBtn');
check('there is a refresh button', btn !== null);

// A change made behind the app's back, the way another device would make it.
await page.evaluate(() => window.__REPO__.upsertTransaction({
  extId: 'outside', kind: 'expense', postedAt: '2026-09-22T10:00:00-06:00',
  merchant: 'Otro telefono', amount: 4000, currency: 'CRC', amountCrc: 4000,
  accountId: 's1', cat: 'wants', scope: 'personal', status: 'settled', reviewed: true,
}));

const unseen = await page.evaluate(() => document.body.textContent.includes('Otro telefono'));
check('a change made elsewhere is not magically on screen', unseen === false);

const callsBefore = await page.evaluate(() => ({ ...window.__calls }));
const viewBefore = await page.evaluate(() => document.querySelector('#nav button.active')?.dataset.view);

await page.click('#refreshBtn');
await page.waitForFunction(() => document.getElementById('refreshBtn')?.classList.contains('busy'), null, { timeout: 2000 })
  .catch(() => {}); // it may already be done on a local stub
await page.waitForFunction(() => !document.getElementById('refreshBtn')?.disabled, null, { timeout: 10000 });

const callsAfter = await page.evaluate(() => ({ ...window.__calls }));
check('refresh re-reads the budget', callsAfter.budget > callsBefore.budget);
check('refresh re-reads the accounts', callsAfter.accounts > callsBefore.accounts);
check('refresh re-reads the ledger', callsAfter.transactions > callsBefore.transactions);
check('refresh re-reads the work charges', callsAfter.work > callsBefore.work);

const viewAfter = await page.evaluate(() => document.querySelector('#nav button.active')?.dataset.view);
check('refresh leaves you on the view you were on', viewBefore === viewAfter,
      `${viewBefore} then ${viewAfter}`);

const nowShown = await page.evaluate(() => document.body.textContent.includes('₡2,434,000'));
check('the outside change is now on screen', nowShown,
      await page.evaluate(() => document.querySelector('.stat')?.textContent));

/* ---- 4. the month you were looking at survives a refresh ---- */

await page.evaluate(() => window.setView('plan'));
await page.evaluate(() => window.setView('transactions'));
await page.selectOption('#monthSel', '2026-08');
await page.click('#refreshBtn');
await page.waitForFunction(() => !document.getElementById('refreshBtn')?.disabled, null, { timeout: 10000 });
const month = await page.evaluate(() => document.getElementById('monthSel').value);
check('refresh keeps the month you were on', month === '2026-08', `on ${month}`);

results.pageErrors = pageErrors.length ? pageErrors : 'none';
if (pageErrors.length) fails.push('pageErrors');

console.log(JSON.stringify(results, null, 2));
await browser.close();
process.exit(fails.length ? 1 : 0);
