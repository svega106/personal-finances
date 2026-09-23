/**
 * Work charges: whose money was it, and has it come back.
 *
 * The distinction that drives everything here — the BNCR card belongs to the
 * company, so spending on it never leaves Sebas's pocket and is never chased.
 * A work expense put on one of his own cards is the opposite.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setRepo } from '../src/repo.js';
import { createMemoryRepo } from '../src/memory-repo.js';
import { loadReference } from '../src/tx.js';
import {
  splitWork, totalByCurrency, isReimbursed, isCompanyPaid,
  initialReimbursement, settle, unsettle, windowStart,
} from '../src/work.js';

const ACCOUNTS = [
  { id: 'bncr', label: 'BNCR VISA ₡ (work)', type: 'card', currency: 'CRC', scope: 'work' },
  { id: 'bac', label: 'BAC VISA ₡', type: 'card', currency: 'CRC', scope: 'personal' },
];

// isCompanyPaid reads the loaded account list, so it has to be primed.
beforeEach(async () => {
  setRepo(createMemoryRepo({ accounts: ACCOUNTS, rules: [], fxRates: [] }));
  await loadReference();
});

const charge = (over) => ({
  id: 'x', scope: 'work', status: 'settled', currency: 'CRC', amount: 1000,
  postedAt: '2026-09-15T12:00:00-06:00', accountId: 'bac', reimbursement: null, ...over,
});

test('a work charge on the company card is not owed to you', () => {
  assert.equal(isCompanyPaid(charge({ accountId: 'bncr' })), true);
});

test('a work charge on your own card is', () => {
  assert.equal(isCompanyPaid(charge({ accountId: 'bac' })), false);
});

test('company-paid charges are kept out of what is chased', () => {
  const { owed, companyPaid } = splitWork([
    charge({ id: 'a', accountId: 'bncr' }),
    charge({ id: 'b', accountId: 'bac' }),
  ]);
  assert.deepEqual(owed.map((t) => t.id), ['b']);
  assert.deepEqual(companyPaid.map((t) => t.id), ['a']);
});

test('a stale pending flag on a company card does not make it owed', () => {
  // Charges ingested before this distinction existed were written pending.
  const { owed, companyPaid } = splitWork([
    charge({ accountId: 'bncr', reimbursement: { status: 'pending' } }),
  ]);
  assert.equal(owed.length, 0, 'the card decides, not the stored flag');
  assert.equal(companyPaid.length, 1);
});

test('an unknown card is treated as your money', () => {
  // Safer to chase something that turns out not to need it than to write off
  // money silently.
  const { owed } = splitWork([charge({ accountId: null })]);
  assert.equal(owed.length, 1);
});

test('a personal-card work charge is owed until reimbursed', () => {
  const { owed } = splitWork([charge({ reimbursement: { status: 'pending' } })]);
  assert.equal(owed.length, 1);
  const { settled } = splitWork([settle(charge(), '2026-10-05')]);
  assert.equal(settled.length, 1);
});

test('undo puts a personal-card charge back to owed', () => {
  const done = settle(charge(), '2026-10-05');
  assert.ok(isReimbursed(done));
  assert.equal(splitWork([unsettle(done)]).owed.length, 1);
});

test('a voided charge is in none of the three', () => {
  const r = splitWork([charge({ status: 'voided' })]);
  assert.equal(r.owed.length + r.settled.length + r.companyPaid.length, 0);
});

test('a new charge starts pending only when the money was yours', () => {
  assert.deepEqual(initialReimbursement(ACCOUNTS[1]), { status: 'pending' });
  assert.equal(initialReimbursement(ACCOUNTS[0]), null, 'company card: nothing to claim');
  assert.deepEqual(initialReimbursement(null), { status: 'pending' }, 'unknown card: assume yours');
});

test('settling records the date and nothing else', () => {
  const t = settle(charge(), '2026-10-05');
  assert.deepEqual(t.reimbursement, { status: 'reimbursed', on: '2026-10-05' });
  assert.equal(t.amount, 1000);
});

test('settle does not mutate the original', () => {
  const original = charge();
  settle(original, '2026-10-05');
  assert.equal(original.reimbursement, null);
});

test('totals stay per currency rather than being converted', () => {
  const totals = totalByCurrency([
    charge({ currency: 'CRC', amount: 25030 }),
    charge({ currency: 'USD', amount: 79.96 }),
    charge({ currency: 'USD', amount: 51.97 }),
  ]);
  assert.equal(totals.CRC, 25030);
  assert.equal(Math.round(totals.USD * 100) / 100, 131.93);
});

test('the window reaches back far enough for a slow reimbursement', () => {
  const start = windowStart(new Date('2026-09-22T12:00:00-06:00'));
  assert.equal(start.slice(0, 7), '2025-03');
  assert.ok(start < '2026-09-15');
});

test('charges from any month are kept together', () => {
  const { owed } = splitWork([
    charge({ id: 'a', postedAt: '2026-08-02T12:00:00-06:00' }),
    charge({ id: 'b', postedAt: '2026-09-15T12:00:00-06:00' }),
  ]);
  assert.deepEqual(owed.map((t) => t.id), ['a', 'b']);
});
