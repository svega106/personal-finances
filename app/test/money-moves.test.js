/**
 * Transfers to a card, and income into savings: who can send and receive,
 * what stops a bad one, the row that is written, and — through the in-memory
 * repository, which mirrors the `account_balances` view — what it does to
 * both balances.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepo } from '../src/memory-repo.js';
import {
  transferSources, transferDestinations, incomeAccounts,
  validateTransfer, validateIncome, transferRow, incomeRow,
} from '../src/money-moves.js';
import { visibleRows } from '../src/views-tx.js';

const AHORROS = { id: 's-crc', label: 'Ahorros ₡', type: 'savings', currency: 'CRC', scope: 'personal',
  issuer: 'bac', brand: 'mastercard', last4: '2207' }; // the debit card lives here
const AHORROS_USD = { id: 's-usd', label: 'Ahorros USD', type: 'savings', currency: 'USD', scope: 'personal' };
const VISA = { id: 'c-visa', label: 'BAC VISA ₡', type: 'card', currency: 'CRC', scope: 'personal',
  issuer: 'bac', last4: '4477' };
const BNCR = { id: 'c-bncr', label: 'BNCR VISA ₡ (work)', type: 'card', currency: 'CRC', scope: 'work',
  issuer: 'bncr', last4: '0828' };
const CASH = { id: 'cash', label: 'Efectivo', type: 'cash', currency: 'CRC', scope: 'personal' };
const ALL = [AHORROS, AHORROS_USD, VISA, BNCR, CASH];

/* ------------------------------------------------------- who takes part */

test('transfers come from savings, and only savings', () => {
  assert.deepEqual(transferSources(ALL).map((a) => a.id), ['s-crc', 's-usd']);
});

test('they go to a personal credit card — not the debit card, not the company card', () => {
  // The debit card is on the Ahorros ₡ row, a savings account, so it is
  // never a destination; the work card is paid by the company.
  assert.deepEqual(transferDestinations(ALL).map((a) => a.id), ['c-visa']);
});

test('income lands in savings', () => {
  assert.deepEqual(incomeAccounts(ALL).map((a) => a.id), ['s-crc', 's-usd']);
});

/* ------------------------------------------------------------ validation */

const funded = { accountId: 's-crc', currentBalance: 100000, hasSnapshot: true };
const ok = { source: AHORROS, dest: VISA, amount: 30000, date: '2026-09-10', balance: funded };

test('a transfer within the balance is fine', () => {
  assert.equal(validateTransfer(ok), null);
  assert.equal(validateTransfer({ ...ok, amount: 100000 }), null, 'exactly everything is allowed');
});

test('a transfer may not take savings below zero', () => {
  const err = validateTransfer({ ...ok, amount: 100000.01 });
  assert.match(err, /below zero/);
  assert.match(err, /₡100,000 is available/);
});

test('the amount must be more than zero', () => {
  for (const amount of [0, -5, NaN, Infinity]) {
    assert.match(validateTransfer({ ...ok, amount }), /more than zero/, String(amount));
    assert.match(validateIncome({ account: AHORROS, amount, date: '2026-09-10' }), /more than zero/);
  }
});

test('the source must be savings and the destination a credit card', () => {
  assert.match(validateTransfer({ ...ok, source: CASH }), /from a savings account/);
  assert.match(validateTransfer({ ...ok, dest: AHORROS }), /Only a credit card/);
  assert.match(validateTransfer({ ...ok, source: null }), /comes from/);
  assert.match(validateTransfer({ ...ok, dest: null }), /Choose the card/);
});

test('with no recorded balance, a transfer is refused rather than guessed at', () => {
  const unknown = { accountId: 's-crc', currentBalance: 0, hasSnapshot: false };
  assert.match(validateTransfer({ ...ok, balance: unknown }), /Record what Ahorros ₡ holds first/);
});

test('editing a transfer counts its own amount as available again', () => {
  // 30,000 already left: 70,000 remains. Raising the same transfer to 90,000
  // needs 60,000 more, which is there.
  const original = { kind: 'transfer', accountId: 's-crc', currency: 'CRC', amount: 30000 };
  const after = { ...funded, currentBalance: 70000 };
  assert.equal(validateTransfer({ ...ok, amount: 90000, balance: after, original }), null);
  assert.match(validateTransfer({ ...ok, amount: 100001, balance: after, original }), /below zero/);
  // Moved to a different source, the original gives nothing back to it.
  assert.match(
    validateTransfer({ ...ok, amount: 90000, balance: after, original: { ...original, accountId: 's-usd' } }),
    /below zero/);
});

test('income needs a savings account and a date', () => {
  assert.equal(validateIncome({ account: AHORROS, amount: 925000, date: '2026-09-15' }), null);
  assert.match(validateIncome({ account: VISA, amount: 1, date: '2026-09-15' }), /savings account/);
  assert.match(validateIncome({ account: AHORROS, amount: 1, date: '' }), /date/);
});

/* ------------------------------------------------------------- the rows */

test('a transfer is one row that names both ends', () => {
  const t = transferRow({ source: AHORROS, dest: VISA, amount: 30000, date: '2026-09-10', note: ' September ' });
  assert.equal(t.kind, 'transfer');
  assert.equal(t.accountId, 's-crc');
  assert.equal(t.counterpartyAccountId, 'c-visa');
  assert.equal(t.cat, null, 'a transfer carries no category (tx_transfer_cat_ck)');
  assert.equal(t.budgetLineId, null);
  assert.equal(t.method, 'transfer');
  assert.equal(t.currency, 'CRC');
  assert.equal(t.amountCrc, 30000);
  assert.equal(t.merchant, 'To BAC VISA ₡');
  assert.equal(t.note, 'September');
  assert.equal(t.reviewed, true);
  assert.match(t.extId, /^manual:/);
});

test('income is its own kind, with no counterparty', () => {
  const t = incomeRow({ account: AHORROS, amount: 925000, date: '2026-09-15', from: 'Paycheck' });
  assert.equal(t.kind, 'income');
  assert.equal(t.accountId, 's-crc');
  assert.equal(t.counterpartyAccountId, null);
  assert.equal(t.merchant, 'Paycheck');
  assert.equal(t.cat, null);
  assert.equal(incomeRow({ account: AHORROS, amount: 1, date: '2026-09-15' }).merchant, 'Income');
});

test('a dollar source makes a dollar transfer, not converted on the day', () => {
  const t = transferRow({ source: AHORROS_USD, dest: VISA, amount: 50, date: '2026-09-10' });
  assert.equal(t.currency, 'USD');
  assert.equal(t.amountCrc, null);
});

test('editing keeps the id and the recorded time when the day is unchanged', () => {
  const existing = { id: 't9', extId: 'manual:x', source: 'manual', postedAt: '2026-09-10T21:15:00-06:00' };
  const same = transferRow({ source: AHORROS, dest: VISA, amount: 1, date: '2026-09-10', existing });
  assert.equal(same.id, 't9');
  assert.equal(same.extId, 'manual:x');
  assert.equal(same.postedAt, existing.postedAt);
  const moved = transferRow({ source: AHORROS, dest: VISA, amount: 1, date: '2026-09-11', existing });
  assert.notEqual(moved.postedAt, existing.postedAt);
});

/* --------------------------------------------------- what the balances do */

test('a transfer takes from savings and pays down the card; income adds to savings', async () => {
  const repo = createMemoryRepo({
    accounts: [AHORROS, VISA],
    snapshots: [{ id: 'sn', accountId: 's-crc', asOf: '2026-09-01', balance: 100000, currency: 'CRC' }],
    transactions: [{
      id: 'x', extId: 'e1', kind: 'expense', postedAt: '2026-09-05T12:00:00-06:00', amount: 50000,
      currency: 'CRC', accountId: 'c-visa', scope: 'personal', status: 'settled',
    }],
  });
  const balances = async () => Object.fromEntries(
    (await repo.listAccountBalances()).map((b) => [b.accountId, b.currentBalance]));

  assert.deepEqual(await balances(), { 's-crc': 100000, 'c-visa': -50000 });

  await repo.upsertTransaction(transferRow({ source: AHORROS, dest: VISA, amount: 30000, date: '2026-09-10' }));
  assert.deepEqual(await balances(), { 's-crc': 70000, 'c-visa': -20000 },
    'savings down 30,000; owed on the card down 30,000');

  await repo.upsertTransaction(incomeRow({ account: AHORROS, amount: 25000, date: '2026-09-12', from: 'Paycheck' }));
  assert.deepEqual(await balances(), { 's-crc': 95000, 'c-visa': -20000 }, 'income touches savings only');
});

test('neither a transfer nor income is spending', async () => {
  const { spendTotals } = await import('../src/tx.js');
  const expense = {
    kind: 'expense', amount: 12000, currency: 'CRC', accountId: 'c-visa', scope: 'personal',
    cat: 'wants', status: 'settled', postedAt: '2026-09-05T12:00:00-06:00',
  };
  const alone = spendTotals([expense]);
  const withMoves = spendTotals([
    expense,
    transferRow({ source: AHORROS, dest: VISA, amount: 30000, date: '2026-09-10' }),
    incomeRow({ account: AHORROS, amount: 925000, date: '2026-09-15' }),
  ]);
  assert.equal(withMoves.total, alone.total);
  assert.equal(withMoves.uncategorized, 0, 'no category is not "uncategorized spending" here');
});

/* ------------------------------------------------- in each account's list */

test('a transfer appears under both accounts, and under no spending category', () => {
  const rows = [
    transferRow({ source: AHORROS, dest: VISA, amount: 1, date: '2026-09-10' }),
    incomeRow({ account: AHORROS, amount: 1, date: '2026-09-10' }),
    { kind: 'expense', accountId: 'c-visa', cat: null, reviewed: true },
  ];
  const f = (x) => ({ account: 'all', cat: 'all', unreviewedOnly: false, ...x });
  const kinds = (x) => visibleRows(rows, f(x)).map((t) => t.kind);

  assert.deepEqual(kinds({ account: 's-crc' }), ['transfer', 'income']);
  assert.deepEqual(kinds({ account: 'c-visa' }), ['transfer', 'expense'], 'found from the side it arrived on');
  assert.deepEqual(kinds({ cat: 'none' }), ['expense'], 'not "uncategorized" spending');
});

/* ------------------------------------------------ between two currencies */

const VISA_USD = { id: 'c-visa-usd', label: 'BAC VISA $', type: 'card', currency: 'USD', scope: 'personal',
  issuer: 'bac', last4: '4477' };
const cross = { source: AHORROS, dest: VISA_USD, amount: 52000, destAmount: 100, date: '2026-09-10', balance: funded };

test('colones to a dollar card asks for both figures', () => {
  assert.equal(validateTransfer(cross), null);
  for (const destAmount of [undefined, 0, -1, NaN]) {
    assert.match(validateTransfer({ ...cross, destAmount }), /came off BAC VISA \$, in dollars/, String(destAmount));
  }
  // What leaves savings is still held to what savings has.
  assert.match(validateTransfer({ ...cross, amount: 100000.01 }), /below zero/);
});

test('within one currency the second figure is neither asked for nor written', () => {
  assert.equal(validateTransfer({ ...ok, destAmount: undefined }), null);
  const t = transferRow({ ...ok, destAmount: 999 });
  assert.equal(t.counterpartyAmount, null, 'a stale second figure is never written');
});

test('a transfer between currencies records what left and what arrived', () => {
  const t = transferRow(cross);
  assert.equal(t.amount, 52000);
  assert.equal(t.currency, 'CRC');
  assert.equal(t.counterpartyAmount, 100);
  assert.equal(t.counterpartyAccountId, 'c-visa-usd');
  assert.equal(incomeRow({ account: AHORROS, amount: 1, date: '2026-09-10' }).counterpartyAmount, null);
});

test('colones out of savings, dollars off the card — no rate involved', async () => {
  const repo = createMemoryRepo({
    accounts: [AHORROS, VISA, VISA_USD],
    snapshots: [{ id: 'sn', accountId: 's-crc', asOf: '2026-09-01', balance: 100000, currency: 'CRC' }],
    transactions: [{
      id: 'x', extId: 'e1', kind: 'expense', postedAt: '2026-09-05T12:00:00-06:00', amount: 150,
      currency: 'USD', accountId: 'c-visa-usd', scope: 'personal', status: 'settled',
    }],
  });
  const balances = async () => Object.fromEntries(
    (await repo.listAccountBalances()).map((b) => [b.accountId, b.currentBalance]));

  await repo.upsertTransaction(transferRow(cross));
  assert.deepEqual(await balances(), { 's-crc': 48000, 'c-visa': 0, 'c-visa-usd': -50 },
    '₡52,000 out of savings; $100 off the $150 owed; the colón half untouched');

  // And a same-currency one right after moves one figure on both ends.
  await repo.upsertTransaction(transferRow({ ...ok, dest: VISA, amount: 8000 }));
  assert.deepEqual(await balances(), { 's-crc': 40000, 'c-visa': 8000, 'c-visa-usd': -50 });
});

/* ------------------------------------------------ the company's card */

test("a charge on the company's card is never personal spending, whatever it is marked", async () => {
  const { setRepo } = await import('../src/repo.js');
  const { loadReference, spendTotals, spendByDay, countsAsSpending } = await import('../src/tx.js');
  setRepo(createMemoryRepo({ accounts: [VISA, BNCR] }));
  await loadReference();

  const charge = (accountId, scope) => ({
    kind: 'expense', amount: 10000, currency: 'CRC', accountId, scope,
    cat: 'wants', status: 'settled', postedAt: '2026-09-05T12:00:00-06:00',
  });
  // Marked personal by hand, but on the BNCR card.
  const rows = [charge('c-visa', 'personal'), charge('c-bncr', 'personal'), charge('c-bncr', 'work')];
  assert.deepEqual(rows.map(countsAsSpending), [true, false, false]);

  const t = spendTotals(rows);
  assert.equal(t.total, 10000, 'only the personal card counts');
  assert.equal(t.excluded, 20000);
  assert.deepEqual(Object.values(spendByDay(rows)), [10000]);
});

/* ------------------------------------------- when an entry is, and what it moves */

test('a new entry is stamped with when it was started, unless a time is picked', () => {
  const openedAt = '2026-09-30T15:07:42-06:00';
  const at = (x) => transferRow({ ...ok, date: '2026-09-30', openedAt, ...x }).postedAt;
  assert.equal(at({ time: '15:07' }), openedAt, 'left alone: the moment, to the second');
  assert.equal(at({ time: '08:30' }), '2026-09-30T08:30:00-06:00', 'picked: as picked');
  assert.equal(incomeRow({ account: AHORROS, amount: 1, date: '2026-09-29', time: '15:07', openedAt }).postedAt,
    '2026-09-29T15:07:00-06:00', 'another day keeps the time shown');
  assert.doesNotMatch(at({ time: '15:07' }), /T12:00:00/, 'never noon');
});

const spend = (id, postedAt, amount) => ({
  id, extId: id, kind: 'expense', postedAt, amount, currency: 'CRC',
  accountId: 's-crc', scope: 'personal', status: 'settled',
});

test('a balance entered today counts what comes after that moment, and not what came before', async () => {
  const repo = createMemoryRepo({
    accounts: [AHORROS],
    snapshots: [{ id: 'sn', accountId: 's-crc', asOf: '2026-09-30', balance: 100000, currency: 'CRC',
      recordedAt: '2026-09-30T15:05:00-06:00' }],
    transactions: [
      spend('before', '2026-09-30T09:00:00-06:00', 1000), // already in the figure typed at 3:05
      spend('after', '2026-09-30T15:30:00-06:00', 2000),  // the expense added afterwards
    ],
  });
  const [b] = await repo.listAccountBalances();
  assert.equal(b.currentBalance, 98000);
  assert.equal(b.snapshotCut, '2026-09-30T15:05:00-06:00');
});

test('a backdated balance includes its whole Costa Rica day, evening too', async () => {
  const repo = createMemoryRepo({
    accounts: [AHORROS],
    snapshots: [{ id: 'sn', accountId: 's-crc', asOf: '2026-09-28', balance: 100000, currency: 'CRC',
      recordedAt: '2026-09-30T10:00:00-06:00' }],
    transactions: [
      // 8:30pm on the 28th is the 29th in UTC — still the 28th here, so in the figure.
      spend('evening', '2026-09-28T20:30:00-06:00', 1000),
      spend('next', '2026-09-29T08:00:00-06:00', 2500),
    ],
  });
  const [b] = await repo.listAccountBalances();
  assert.equal(b.currentBalance, 97500);
});

test('re-entering a balance later the same day moves the moment it stands for', async () => {
  const { crDay } = await import('../src/cr-date.js');
  const repo = createMemoryRepo({ accounts: [AHORROS] });
  await repo.saveSnapshot({ accountId: 's-crc', asOf: crDay(new Date()), balance: 50000, currency: 'CRC' });
  const [b] = await repo.listAccountBalances();
  assert.ok(b.snapshotCut, 'a recorded moment');
  assert.ok(Date.parse(b.snapshotCut) <= Date.now() && Date.now() - Date.parse(b.snapshotCut) < 5000);
});

test('a balance dated ahead of when it was entered stands for the moment it was entered', async () => {
  // Ahorros Colones as it was: saved "as of Oct 1" at 10:36pm on Sep 30, and
  // again "as of Sep 30" at 11:06pm. Entries on Oct 1 did not move it.
  const repo = createMemoryRepo({
    accounts: [AHORROS],
    snapshots: [
      { id: 'a', accountId: 's-crc', asOf: '2026-10-01', balance: 870040.15, currency: 'CRC', recordedAt: '2026-09-30T22:36:00-06:00' },
      { id: 'b', accountId: 's-crc', asOf: '2026-09-30', balance: 870040.15, currency: 'CRC', recordedAt: '2026-09-30T23:06:00-06:00' },
    ],
    transactions: [
      spend('before', '2026-09-30T22:11:00-06:00', 22800),    // before it was entered: in the figure
      spend('w1', '2026-10-01T10:17:00-06:00', 21000),
      spend('w2', '2026-10-01T10:49:00-06:00', 10000),
      spend('big', '2026-10-01T11:03:00-06:00', 600000),
    ],
  });
  const [b] = await repo.listAccountBalances();
  assert.equal(b.snapshotDate, '2026-09-30', 'never a day that had not happened');
  assert.equal(b.snapshotCut, '2026-09-30T23:06:00-06:00', 'the one entered last that day');
  assert.equal(Math.round(b.currentBalance * 100) / 100, 239040.15);
});
