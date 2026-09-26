/**
 * Drives the transactions view against a seeded in-memory repository:
 * renders it, filters it, adds a transaction through the modal, and checks
 * the result reached the store.
 *
 *   node tools/tx-smoke.mjs http://localhost:4220/
 */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:4220/';

const ACCOUNTS = [
  { id: 'a-bac-visa', label: 'BAC VISA \u20a1', type: 'card', last4: '4477', currency: 'CRC', scope: 'personal' },
  { id: 'a-bac-visa-usd', label: 'BAC VISA $', type: 'card', last4: '4477', currency: 'USD', scope: 'personal' },
  { id: 'a-bac-amex', label: 'BAC AMEX \u20a1', type: 'card', last4: '9654', currency: 'CRC', scope: 'personal' },
  { id: 'a-bac-amex-usd', label: 'BAC AMEX $', type: 'card', last4: '9654', currency: 'USD', scope: 'personal' },
  { id: 'a-bncr-usd', label: 'BNCR VISA $ (work)', type: 'card', last4: '0828', currency: 'USD', scope: 'work' },
  { id: 'a-cash', label: 'Efectivo', type: 'cash', last4: null, currency: 'CRC', scope: 'personal' },
];

const TX = [
  { id: 't1', extId: 'bac:4477:919824:626502675560', kind: 'expense', postedAt: '2026-09-21T20:38:00-06:00',
    merchantRaw: 'AUTO MERCADO HEREDIA', merchant: 'Auto Mercado', amount: 6980, currency: 'CRC',
    amountCrc: 6980, accountId: 'a-bac-visa', scope: 'personal', cat: 'needs', budgetLineId: 'b-groceries',
    source: 'email', method: 'card', status: 'pending', reviewed: true },
  { id: 't2', extId: 'bac:9654:004521:626401998877', kind: 'expense', postedAt: '2026-09-21T18:45:00-06:00',
    merchantRaw: 'UBER EATS COSTA RICA', merchant: 'Uber Eats', amount: 12450, currency: 'CRC',
    amountCrc: 12450, accountId: 'a-bac-amex', scope: 'personal', cat: 'wants', budgetLineId: null,
    source: 'email', method: 'card', status: 'pending', reviewed: true },
  // Unreviewed, uncategorized — should show as Unbudgeted and drive the badge.
  { id: 't3', extId: 'bac:4477:111111:999999999999', kind: 'expense', postedAt: '2026-09-20T13:59:00-06:00',
    merchantRaw: 'KIOSKO SAMSUNG SLC MAL', merchant: null, amount: 89000, currency: 'CRC',
    amountCrc: 89000, accountId: 'a-bac-visa', scope: 'personal', cat: null, budgetLineId: null,
    source: 'email', method: 'card', status: 'pending', reviewed: false },
  // Work scope: must be excluded from personal spend.
  { id: 't4', extId: 'bncr:0828:964732:625812522165', kind: 'expense', postedAt: '2026-09-15T06:30:00-06:00',
    merchantRaw: 'FACEBK SWRK766KH4', merchant: 'Facebook Ads', amount: 79.96, currency: 'USD',
    amountCrc: null, fxRate: null, accountId: 'a-bncr-usd', scope: 'work', cat: null,
    source: 'email', method: 'card', status: 'pending', reviewed: true },
  // Personal USD charge: excluded from colón totals until a rate is set.
  { id: 't6', extId: 'bac:9654:231347:t202609201845', kind: 'expense', postedAt: '2026-09-20T18:45:00-06:00',
    merchantRaw: 'UBER EATS COSTA RICA', merchant: 'Uber Eats', amount: 61.90, currency: 'USD',
    amountCrc: null, fxRate: null, accountId: 'a-bac-amex-usd', scope: 'personal', cat: 'wants',
    source: 'email', method: 'card', status: 'pending', reviewed: true },
  // Different month: must not appear.
  { id: 't5', extId: 'bac:4477:222222:888888888888', kind: 'expense', postedAt: '2026-08-14T10:00:00-06:00',
    merchantRaw: 'OLD CHARGE', merchant: 'Old charge', amount: 5000, currency: 'CRC',
    amountCrc: 5000, accountId: 'a-bac-visa', scope: 'personal', cat: 'wants',
    source: 'email', method: 'card', status: 'settled', reviewed: true },
];

const SEED = {
  months: { '2026-09': {
    income: 1850000, extraIncome: [], bills: [], recurring: [], oneTime: [],
    contributions: {}, invest: 0, usedCarryover: 0 } },
  goals: [],
  settings: { alloc: { needs: 50, wants: 30, savings: 20 }, name: 'Sebas' },
  accounts: ACCOUNTS,
  rules: [{ id: 'r1', pattern: 'KIOSKO SAMSUNG', matchType: 'contains', priority: 50,
            cat: 'wants', budgetLineId: null, scope: null, merchantClean: 'Samsung' }],
  transactions: TX,
  fxRates: [],
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());

await page.addInitScript((seed) => {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const store = clone(seed);
  let seq = 100;
  window.__REPO__ = {
    loadAll: async () => ({ months: clone(store.months), goals: clone(store.goals), settings: clone(store.settings) }),
    saveBudget: async (m, d) => { store.months[m] = clone(d); },
    deleteBudget: async (m) => { delete store.months[m]; },
    saveGoals: async (g) => { store.goals = clone(g); },
    saveSettings: async (s) => { store.settings = clone(s); },
    listAccounts: async () => clone(store.accounts),
    listRules: async () => clone(store.rules),
    listFxRates: async () => clone(store.fxRates || []),
    countTransactions: async (id) => (store.transactions || [])
      .filter((t) => t.accountId === id || t.counterpartyAccountId === id).length,
    listWorkCharges: async ({ since }) => clone(store.transactions || [])
      .filter((t) => t.scope === 'work' && t.postedAt >= since)
      .sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1)),
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
      const at = store.transactions.findIndex((x) => (row.id && x.id === row.id) || x.extId === row.extId);
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

  const FIXED = new Date('2026-09-21T12:00:00-06:00').getTime();
  const R = Date;
  Date = class extends R {
    constructor(...a) { return a.length ? new R(...a) : new R(FIXED); }
    static now() { return FIXED; }
  };
  Date.prototype = R.prototype;
}, SEED);

const out = {};
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  out[name] = ok ? 'PASS' : `FAIL  got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`;
};

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.setView === 'function', null, { timeout: 10000 });

// ---------------------------------------------------------------- render
await page.evaluate(() => window.setView('transactions'));
await page.waitForSelector('.tx-row', { timeout: 5000 });

check('rows shown for September', await page.locator('.tx-row').count(), 5);
check('days grouped', await page.locator('.tx-day').count(), 3);

const stats = await page.locator('.tx-summary [data-stat]').allInnerTexts();
// Colon personal charges only: 6,980 + 12,450 + 89,000. Both USD charges
// are excluded because September has no rate yet.
check('USD stays out of the totals', stats[0], '₡108,430');
check('essentials total', stats[1], '₡6,980');
check('discretionary total', stats[2], '₡12,450');
check('uncategorized total', stats[3], '₡89,000');

check('unreviewed badge', await page.locator('#nav button[data-view="transactions"] .badge').innerText(), '1');
check('unconverted balance shown', await page.locator('.tx-pending b').innerText(), '$141.86');
check('unconverted charges flagged', await page.locator('.tx-unconv').count(), 2);
check('work chip', await page.locator('.tx-work').count(), 1);
check('unbudgeted chip', await page.locator('.tx-none').count(), 1);

// --------------------------------------------------------------- filters
await page.evaluate(() => window.txSetFilter('unreviewedOnly', true));
await page.waitForTimeout(200);
check('needs-review filter', await page.locator('.tx-row').count(), 1);

await page.evaluate(() => window.txSetFilter('unreviewedOnly', false));
await page.evaluate(() => window.txSetFilter('account', 'a-bac-visa'));
await page.waitForTimeout(200);
check('account filter', await page.locator('.tx-row').count(), 2);

// ------------------------------------------------ setting the month rate
await page.evaluate(() => window.txSetFilter('account', 'all'));
await page.waitForTimeout(150);
await page.evaluate(() => window.txRateModal());
await page.waitForSelector('#fx_rate');
await page.fill('#fx_rate', '449.49');
await page.click('#fx_save');
await page.waitForTimeout(500);

const afterFx = await page.locator('.tx-summary [data-stat]').allInnerTexts();
// Only the personal USD charge joins the total: 108,430 + 61.90 x 449.49.
// The work-card $79.96 stays out, exactly as it does in colones.
check('USD folded in once the rate is set', afterFx[0], '\u20a1136,253');
check('pending note gone', await page.locator('.tx-pending').count(), 0);
check('USD row now shows colones', await page.locator('.tx-unconv').count(), 0);

await page.evaluate(() => window.txSetFilter('account', 'all'));
await page.waitForTimeout(200);

// ------------------------------------------------------- add a manual one
await page.evaluate(() => window.txEdit());
await page.waitForSelector('#tx_name');
await page.fill('#tx_name', 'Feria del agricultor');
await page.fill('#tx_amount', '18500');
await page.selectOption('#tx_cat', 'needs');
await page.selectOption('#tx_account', 'a-cash');
await page.click('#tx_save');
await page.waitForTimeout(600);

check('row added', await page.locator('.tx-row').count(), 6);
const stats2 = await page.locator('.tx-summary [data-stat]').allInnerTexts();
check('total includes manual entry', stats2[0], '₡154,753'); // 136,253 + 18,500

const stored = await page.evaluate(() => {
  const t = window.__REPO__._dump().transactions.find((x) => x.merchant === 'Feria del agricultor');
  return t ? { cat: t.cat, amountCrc: t.amountCrc, source: t.source, method: t.method, reviewed: t.reviewed } : null;
});
check('manual entry persisted', stored,
  { cat: 'needs', amountCrc: 18500, source: 'manual', method: 'cash', reviewed: true });

// ------------------------------------------------- edit an existing one
await page.evaluate(() => window.txEdit('t3'));
await page.waitForSelector('#tx_name');
await page.selectOption('#tx_cat', 'wants');
await page.click('#tx_save');
await page.waitForTimeout(600);

check('badge cleared after review',
  await page.locator('#nav button[data-view="transactions"] .badge').count(), 0);

const stats3 = await page.locator('.tx-summary [data-stat]').allInnerTexts();
check('uncategorized drops after categorizing', stats3[3], '₡0');

// ------------------------------------------------- other views unaffected
await page.evaluate(() => window.setView('dashboard'));
await page.waitForTimeout(300);
check('dashboard still renders',
  /financial health/i.test(await page.locator('#views').innerText()), true);

out.pageErrors = errors.length ? errors : 'none';
await browser.close();

console.log(JSON.stringify(out, null, 2));
const failed = Object.entries(out).filter(([k, v]) => v !== 'PASS' && k !== 'pageErrors');
process.exit(failed.length || errors.length ? 1 : 0);
