/**
 * Work charges and settling them.
 *
 * The behaviour that matters: a charge is outstanding until it says it is
 * reimbursed, settling records only a date, and undo is real rather than a
 * second flag layered on top.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitWork, totalByCurrency, isReimbursed, settle, unsettle, windowStart,
} from '../src/work.js';

const charge = (over) => ({
  id: 'x', scope: 'work', status: 'settled', currency: 'CRC', amount: 1000,
  postedAt: '2026-09-15T12:00:00-06:00', reimbursement: null, ...over,
});

test('a charge with no reimbursement object is outstanding', () => {
  const { outstanding, settled } = splitWork([charge()]);
  assert.equal(outstanding.length, 1);
  assert.equal(settled.length, 0);
});

test('a pending charge is outstanding', () => {
  const { outstanding } = splitWork([charge({ reimbursement: { status: 'pending' } })]);
  assert.equal(outstanding.length, 1);
});

test('only an explicit reimbursed status counts as settled', () => {
  const { settled } = splitWork([charge({ reimbursement: { status: 'reimbursed', on: '2026-10-05' } })]);
  assert.equal(settled.length, 1);
});

test('a voided charge is neither', () => {
  const { outstanding, settled } = splitWork([charge({ status: 'voided' })]);
  assert.equal(outstanding.length + settled.length, 0);
});

test('settling records the date and nothing else', () => {
  const t = settle(charge(), '2026-10-05');
  assert.deepEqual(t.reimbursement, { status: 'reimbursed', on: '2026-10-05' });
  assert.equal(t.amount, 1000, 'the charge itself is untouched');
  assert.equal(t.id, 'x');
});

test('undo puts a charge back to outstanding', () => {
  const done = settle(charge(), '2026-10-05');
  assert.ok(isReimbursed(done));
  const back = unsettle(done);
  assert.equal(isReimbursed(back), false);
  assert.equal(splitWork([back]).outstanding.length, 1);
});

test('settle does not mutate the original', () => {
  const original = charge();
  settle(original, '2026-10-05');
  assert.equal(original.reimbursement, null, 'a cached row must not change under the view');
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
  assert.equal(start.slice(0, 7), '2025-03', 'eighteen months back');
  assert.ok(start < '2026-09-15', 'covers a charge from this month');
});

test('charges from any month are kept together', () => {
  // The whole point: September charges reimbursed in October must be
  // settleable without navigating back to September.
  const { outstanding } = splitWork([
    charge({ id: 'a', postedAt: '2026-08-02T12:00:00-06:00' }),
    charge({ id: 'b', postedAt: '2026-09-15T12:00:00-06:00' }),
  ]);
  assert.deepEqual(outstanding.map((t) => t.id), ['a', 'b']);
});
