/**
 * Editing and retiring accounts.
 *
 * The rule worth pinning down: an account is archived, never deleted.
 * Transactions and balance snapshots point at accounts, so removing one would
 * either orphan that history or take it along.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setRepo, getRepo } from '../src/repo.js';
import { createMemoryRepo } from '../src/memory-repo.js';

const ACCOUNTS = [
  { id: 'ef', label: 'Efectivo', type: 'cash', currency: 'CRC', scope: 'personal' },
  { id: 's1', label: 'Ahorros ₡', type: 'savings', currency: 'CRC', scope: 'personal' },
  { id: 's2', label: 'Ahorros $', type: 'savings', currency: 'USD', scope: 'personal' },
];

const TX = [
  { id: 't1', accountId: 's1', amount: 1000, currency: 'CRC', scope: 'personal' },
  { id: 't2', accountId: 's1', amount: 2000, currency: 'CRC', scope: 'personal' },
  { id: 't3', accountId: 's2', amount: 30, currency: 'USD', scope: 'personal' },
];

let repo;
beforeEach(() => {
  repo = createMemoryRepo({ accounts: structuredClone(ACCOUNTS), transactions: structuredClone(TX) });
  setRepo(repo);
});

test('an account can be renamed without disturbing anything else', async () => {
  await repo.upsertAccount({ ...ACCOUNTS[1], label: 'Ahorros principal' });
  const list = await repo.listAccounts();
  assert.equal(list.find((a) => a.id === 's1').label, 'Ahorros principal');
  assert.equal(list.length, 3);
});

test('archiving takes an account out of the list', async () => {
  await repo.archiveAccount('ef');
  const list = await repo.listAccounts();
  assert.deepEqual(list.map((a) => a.id), ['s1', 's2']);
});

test('archiving does not delete the transactions that point at it', async () => {
  await repo.archiveAccount('s1');
  const all = repo._dump().transactions;
  assert.equal(all.length, 3, 'the ledger is untouched');
  assert.equal(all.filter((t) => t.accountId === 's1').length, 2);
});

test('the count behind the warning is the number that would be affected', async () => {
  assert.equal(await repo.countTransactions('s1'), 2);
  assert.equal(await repo.countTransactions('s2'), 1);
  assert.equal(await repo.countTransactions('ef'), 0, 'nothing to warn about');
});

test('a transfer counts against both of its accounts', async () => {
  repo = createMemoryRepo({
    accounts: structuredClone(ACCOUNTS),
    transactions: [{ id: 'x', kind: 'transfer', accountId: 's1', counterpartyAccountId: 's2', amount: 5000, currency: 'CRC' }],
  });
  assert.equal(await repo.countTransactions('s1'), 1);
  assert.equal(await repo.countTransactions('s2'), 1, 'the other side counts too');
});

test('a card can be attached to an account, and taken off again', async () => {
  // A debit card is not an account of its own; it spends from one.
  await repo.upsertAccount({ ...ACCOUNTS[1], issuer: 'bac', brand: 'mastercard', last4: '2207' });
  let a = (await repo.listAccounts()).find((x) => x.id === 's1');
  assert.equal(a.issuer, 'bac');
  assert.equal(a.last4, '2207');

  await repo.upsertAccount({ ...ACCOUNTS[1], issuer: null, brand: null, last4: null });
  a = (await repo.listAccounts()).find((x) => x.id === 's1');
  assert.equal(a.last4, null);
});

test('adding an account leaves the existing ones alone', async () => {
  await repo.upsertAccount({ label: 'Inversiones', type: 'investment', currency: 'CRC' });
  const list = await repo.listAccounts();
  assert.equal(list.length, 4);
  assert.ok(list.find((a) => a.label === 'Inversiones').id, 'got an id');
  assert.deepEqual(list.slice(0, 3).map((a) => a.label), ['Efectivo', 'Ahorros ₡', 'Ahorros $']);
});
