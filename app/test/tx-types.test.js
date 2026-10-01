/**
 * Transaction types: what they resolve to, what counts as spending, what is
 * owed back — and a reimbursement income settling the charges it pays back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepo } from '../src/memory-repo.js';
import { setRepo } from '../src/repo.js';
import { init, state } from '../src/state.js';
import {
  BUILTIN, KEY, resolveTypes, typeFor, newTypeKey, txTypes, typeOf, owedTypeKeys,
  updateType, addType, removeType,
} from '../src/tx-types.js';
import { loadReference, spendTotals, countsAsSpending } from '../src/tx.js';
import { reimbursementChanges, settle, splitWork } from '../src/work.js';
import { incomeRow } from '../src/money-moves.js';

const AHORROS = { id: 's-crc', label: 'Ahorros ₡', type: 'savings', currency: 'CRC', scope: 'personal',
  issuer: 'bac', last4: '2207' };
const VISA = { id: 'c-visa', label: 'BAC VISA ₡', type: 'card', currency: 'CRC', scope: 'personal', issuer: 'bac', last4: '4477' };
const BNCR = { id: 'c-bncr', label: 'BNCR VISA ₡ (work)', type: 'card', currency: 'CRC', scope: 'work', issuer: 'bncr', last4: '0828' };

async function boot(seed = {}) {
  const repo = createMemoryRepo({ accounts: [AHORROS, VISA, BNCR], ...seed });
  setRepo(repo);
  await init();
  await loadReference();
  return repo;
}

/* ---------------------------------------------------------- the list itself */

test('with nothing set, Personal counts and Work is paid back', () => {
  const types = resolveTypes(undefined);
  assert.deepEqual(types.map((t) => [t.key, t.spending, t.reimbursable]),
    [['personal', true, false], ['work', false, true]]);
});

test('edits to the built-ins apply, but Personal always counts and is never owed back', () => {
  const types = resolveTypes([
    { key: 'personal', label: 'Mine', spending: false, reimbursable: true },
    { key: 'work', label: 'Trabajo', spending: true },
  ]);
  assert.deepEqual(types[0], { ...BUILTIN[0], label: 'Mine' });
  assert.equal(types[1].label, 'Trabajo');
  assert.equal(types[1].spending, true);
  assert.equal(types[1].reimbursable, true, 'unset keeps the default');
});

test('added types follow the built-ins; anything malformed is dropped', () => {
  const types = resolveTypes([
    { key: 'shared', label: 'Shared with Ana', spending: false, reimbursable: true },
    { key: 'Bad Key', label: 'nope' }, null, 'junk',
    { key: 'gift', label: '', spending: 1 },
  ]);
  assert.deepEqual(types.map((t) => t.key), ['personal', 'work', 'shared', 'gift']);
  assert.equal(types[3].label, 'Untitled');
  assert.equal(types[3].spending, true);
});

test('an unknown key reads as Personal — counted, never silently dropped', () => {
  const types = resolveTypes([]);
  assert.equal(typeFor('removed-elsewhere', types).key, 'personal');
  assert.equal(typeFor(undefined, types).key, 'personal');
});

test('a new key is valid for the database and unlike any in use', () => {
  const types = resolveTypes([{ key: 'tabc', label: 'x' }]);
  const key = newTypeKey(types, 0x11);
  assert.match(key, KEY);
  assert.ok(!types.some((t) => t.key === key));
});

/* ------------------------------------------------- changing it in Settings */

test('adding, renaming, switching and removing a type', async () => {
  await boot();
  const { type } = addType('Shared with Ana');
  assert.equal(type.spending, false, 'a new type starts out of spending');
  assert.equal(addType('shared with ana').error, 'There is already a type called shared with ana');
  assert.equal(addType('  ').error, 'Give the type a name');

  updateType(type.key, { label: 'Shared', reimbursable: true });
  assert.deepEqual(txTypes().find((t) => t.key === type.key),
    { key: type.key, label: 'Shared', spending: false, reimbursable: true, builtin: false });
  assert.deepEqual(owedTypeKeys(), ['work', type.key]);

  updateType('personal', { spending: false, label: 'Personal' });
  assert.equal(txTypes()[0].spending, true, 'Personal cannot be switched off');

  assert.equal(removeType('work'), false, 'the built-ins stay');
  assert.equal(removeType(type.key), true);
  assert.deepEqual(txTypes().map((t) => t.key), ['personal', 'work']);
  assert.ok(Array.isArray(state.settings.txTypes), 'kept in settings, synced like the rest');
});

/* ------------------------------------------------------------ what counts */

const charge = (id, over = {}) => ({
  id, kind: 'expense', amount: 10000, currency: 'CRC', accountId: 'c-visa', scope: 'personal',
  cat: 'wants', status: 'settled', postedAt: '2026-09-05T12:00:00-06:00', ...over,
});

test('spending counts only the types switched on', async () => {
  await boot();
  const { type } = addType('Shared');
  const rows = [
    charge('p'),
    charge('w', { scope: 'work' }),
    charge('s', { scope: type.key }),
  ];
  assert.equal(spendTotals(rows).total, 10000);
  assert.equal(spendTotals(rows).excluded, 20000);

  updateType(type.key, { spending: true });
  assert.equal(spendTotals(rows).total, 20000, 'switched on: it counts');

  updateType('work', { spending: true });
  assert.equal(spendTotals(rows).total, 30000, 'even Work, if you say so');
});

test("the company's card never counts, whatever its charges are marked", async () => {
  await boot();
  updateType('work', { spending: true });
  const rows = [charge('b1', { accountId: 'c-bncr', scope: 'work' }), charge('b2', { accountId: 'c-bncr' })];
  assert.deepEqual(rows.map(countsAsSpending), [false, false]);
  assert.equal(spendTotals(rows).total, 0);
});

test('a work expense from savings lowers the balance, and is not spending', async () => {
  const repo = await boot({
    snapshots: [{ id: 'sn', accountId: 's-crc', asOf: '2026-09-01', balance: 100000, currency: 'CRC' }],
  });
  const t = await repo.upsertTransaction(charge('lunch', {
    extId: 'lunch', accountId: 's-crc', scope: 'work', reimbursement: { status: 'pending' },
  }));
  const ahorros = async () => (await repo.listAccountBalances()).find((b) => b.accountId === 's-crc').currentBalance;
  assert.equal(await ahorros(), 90000, 'the money left the account');
  assert.equal(spendTotals([t]).total, 0, 'but it is not your spending');

  // The money comes back as income: the balance is whole again.
  await repo.upsertTransaction(incomeRow({ account: AHORROS, amount: 10000, date: '2026-09-20', from: 'Reimbursement' }));
  assert.equal(await ahorros(), 100000);
});

/* ---------------------------------------- a reimbursement settles what it covers */

test('an income that pays back charges settles them, and only them', () => {
  const owed = [
    charge('a', { scope: 'work', reimbursement: { status: 'pending' } }),
    charge('b', { scope: 'work', reimbursement: { status: 'pending' } }),
  ];
  const { settle: s, unsettle: u } = reimbursementChanges({
    incomeId: 'inc1', on: '2026-09-30', before: [], after: ['a'], rows: owed,
  });
  assert.deepEqual(s.map((t) => [t.id, t.reimbursement]), [['a', { status: 'reimbursed', on: '2026-09-30', by: 'inc1' }]]);
  assert.deepEqual(u, []);
});

test('editing it: a charge taken off goes back to owed; one already settled by it is left alone', () => {
  const rows = [
    settle(charge('a', { scope: 'work' }), '2026-09-30', 'inc1'),
    settle(charge('b', { scope: 'work' }), '2026-09-30', 'inc1'),
    charge('c', { scope: 'work', reimbursement: { status: 'pending' } }),
  ];
  const { settle: s, unsettle: u } = reimbursementChanges({
    incomeId: 'inc1', on: '2026-09-30', before: ['a', 'b'], after: ['a', 'c'], rows,
  });
  assert.deepEqual(s.map((t) => t.id), ['c'], 'a is already settled by this income on this day');
  assert.deepEqual(u.map((t) => [t.id, t.reimbursement]), [['b', { status: 'pending' }]]);
});

test('deleting it puts back only what it settled — not a charge marked reimbursed some other way', () => {
  const rows = [
    settle(charge('a', { scope: 'work' }), '2026-09-30', 'inc1'),
    settle(charge('x', { scope: 'work' }), '2026-09-12'), // marked by hand
  ];
  const { unsettle: u } = reimbursementChanges({ incomeId: 'inc1', before: ['a', 'x'], after: [], rows });
  assert.deepEqual(u.map((t) => t.id), ['a']);
});

test('the owed list is every type paid back to you, and only expenses', async () => {
  const repo = await boot();
  const { type } = addType('Shared');
  updateType(type.key, { reimbursable: true });
  await repo.upsertTransaction(charge('w', { extId: 'w', scope: 'work', reimbursement: { status: 'pending' } }));
  await repo.upsertTransaction(charge('s', { extId: 's', scope: type.key, reimbursement: { status: 'pending' } }));
  await repo.upsertTransaction(charge('p', { extId: 'p' }));
  await repo.upsertTransaction({ ...incomeRow({ account: AHORROS, amount: 1, date: '2026-09-20' }), scope: 'work', extId: 'i' });
  const rows = await repo.listWorkCharges({ since: '2000-01-01', scopes: owedTypeKeys() });
  assert.deepEqual(rows.map((t) => t.id).sort(), ['s', 'w']);
  assert.equal(splitWork(rows).owed.length, 2);
  assert.equal(typeOf(rows.find((t) => t.id === 's')).label, 'Shared');
});
