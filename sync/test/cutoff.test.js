import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cutoffIn, nextCutoff, daysBetween, upcomingCutoffs, dueReminders, sentKey, reminderText,
} from '../../supabase/functions/_shared/cutoff.js';

/* ------------------------------------------------------------ the dates */

test('a day the month does not have means its last day', () => {
  assert.equal(cutoffIn(2026, 2, 31), '2026-02-28');
  assert.equal(cutoffIn(2028, 2, 31), '2028-02-29'); // leap year
  assert.equal(cutoffIn(2026, 4, 31), '2026-04-30');
  assert.equal(cutoffIn(2026, 1, 31), '2026-01-31');
  assert.equal(cutoffIn(2026, 2, 15), '2026-02-15');
});

test('a cutoff falling today is today, not next month', () => {
  assert.equal(nextCutoff(15, '2026-09-15'), '2026-09-15');
});

test('a cutoff already passed this month is next month', () => {
  assert.equal(nextCutoff(15, '2026-09-16'), '2026-10-15');
  assert.equal(nextCutoff(15, '2026-09-14'), '2026-09-15');
});

test('December rolls into January of the next year', () => {
  assert.equal(nextCutoff(10, '2026-12-20'), '2027-01-10');
});

test('"the 31st" after a short month lands on that month’s last day', () => {
  // 31 Jan has passed; February has no 31st.
  assert.equal(nextCutoff(31, '2026-02-01'), '2026-02-28');
  assert.equal(nextCutoff(31, '2026-03-01'), '2026-03-31');
});

test('days between keys, across a month and a year', () => {
  assert.equal(daysBetween('2026-09-26', '2026-09-26'), 0);
  assert.equal(daysBetween('2026-09-26', '2026-10-15'), 19);
  assert.equal(daysBetween('2026-12-30', '2027-01-02'), 3);
});

/* ------------------------------------------------------------ the cards */

const card = (id, label, issuer, last4, currency, extra = {}) => ({
  id, label, type: 'card', issuer, last4, currency, active: true, ...extra,
});

const ACCOUNTS = [
  card('v1', 'BAC VISA ₡', 'bac', '4477', 'CRC', { cutoffDay: 15, cutoffWarnDays: 3 }),
  card('v2', 'BAC VISA $', 'bac', '4477', 'USD', { cutoffDay: 15, cutoffWarnDays: 3 }),
  card('d1', 'Davivienda ₡', 'davivienda', '5131', 'CRC', { cutoffDay: 28, cutoffWarnDays: 5 }),
  card('p1', 'Promerica ₡', 'promerica', '1763', 'CRC'), // no cutoff set
  // The debit card is recorded on the savings account, and has no bill.
  { id: 's1', label: 'Ahorros ₡', type: 'savings', issuer: 'bac', last4: '2207',
    currency: 'CRC', active: true, cutoffDay: 20, cutoffWarnDays: 3 },
];

test('one entry per physical card, soonest first', () => {
  const list = upcomingCutoffs(ACCOUNTS, '2026-09-26');
  assert.deepEqual(list.map((c) => [c.name, c.cutoffDate, c.daysLeft]), [
    ['Davivienda', '2026-09-28', 2],
    ['BAC VISA', '2026-10-15', 19],
  ]);
  assert.deepEqual(list[1].accountIds, ['v1', 'v2']);
});

test('the debit card on the savings account never gets a cutoff', () => {
  const list = upcomingCutoffs(ACCOUNTS, '2026-09-18');
  assert.ok(!list.some((c) => c.cardKey === 'bac:2207'));
});

test('a card without a cutoff is left out rather than guessed', () => {
  assert.ok(!upcomingCutoffs(ACCOUNTS, '2026-09-26').some((c) => c.cardKey === 'promerica:1763'));
});

test('an archived card is left out', () => {
  const list = upcomingCutoffs([card('x', 'Old ₡', 'bac', '1111', 'CRC',
    { cutoffDay: 10, active: false })], '2026-09-01');
  assert.equal(list.length, 0);
});

test('the warning window is each card’s own', () => {
  const byName = Object.fromEntries(
    upcomingCutoffs(ACCOUNTS, '2026-09-23').map((c) => [c.name, c.warning]));
  // Davivienda warns 5 days out and is 5 away; BAC warns 3 out and is 22 away.
  assert.equal(byName.Davivienda, true);
  assert.equal(byName['BAC VISA'], false);

  const twelfth = upcomingCutoffs(ACCOUNTS, '2026-10-12').find((c) => c.name === 'BAC VISA');
  assert.equal(twelfth.daysLeft, 3);
  assert.equal(twelfth.warning, true);
});

test('zero warning days warns on the cutoff day only', () => {
  const zero = [card('z', 'Zero ₡', 'bac', '2222', 'CRC', { cutoffDay: 10, cutoffWarnDays: 0 })];
  assert.equal(upcomingCutoffs(zero, '2026-09-09')[0].warning, false);
  assert.equal(upcomingCutoffs(zero, '2026-09-10')[0].warning, true);
});

test('a card with no warning days stored uses the default of 3', () => {
  const plain = [card('q', 'Plain ₡', 'bac', '3333', 'CRC', { cutoffDay: 10 })];
  assert.equal(upcomingCutoffs(plain, '2026-09-07')[0].warnDays, 3);
  assert.equal(upcomingCutoffs(plain, '2026-09-07')[0].warning, true);
});

test('if the two halves ever disagree, the colón half speaks for the card', () => {
  const split = [
    card('u', 'Split $', 'bac', '4444', 'USD', { cutoffDay: 5, cutoffWarnDays: 1 }),
    card('c', 'Split ₡', 'bac', '4444', 'CRC', { cutoffDay: 20, cutoffWarnDays: 3 }),
  ];
  const [only] = upcomingCutoffs(split, '2026-09-01');
  assert.equal(only.cutoffDay, 20);
  assert.equal(only.warnDays, 3);
});

/* ------------------------------------------------------- what to send */

test('due: only cards inside their window', () => {
  const due = dueReminders(ACCOUNTS, '2026-09-26');
  assert.deepEqual(due.map((c) => c.name), ['Davivienda']);
});

test('due: a reminder already sent for this cutoff is not sent again', () => {
  const [entry] = dueReminders(ACCOUNTS, '2026-09-26');
  const sent = new Set([sentKey(entry)]);
  assert.equal(dueReminders(ACCOUNTS, '2026-09-27', sent).length, 0);
});

test('due: a missed day still sends — the window, not one exact day', () => {
  // Davivienda should have gone out on the 23rd (5 days before the 28th).
  // The job did not run until the 27th: it is still owed.
  assert.deepEqual(dueReminders(ACCOUNTS, '2026-09-27').map((c) => c.name), ['Davivienda']);
});

test('due: next month’s cutoff is a new reminder', () => {
  const [sept] = dueReminders(ACCOUNTS, '2026-09-26');
  const sent = new Set([sentKey(sept)]);
  const oct = dueReminders(ACCOUNTS, '2026-10-25', sent);
  assert.deepEqual(oct.map((c) => [c.name, c.cutoffDate]), [['Davivienda', '2026-10-28']]);
});

test('due: two people with the same card number are two reminders', () => {
  const both = [
    card('a', 'BAC VISA ₡', 'bac', '4477', 'CRC', { userId: 'u1', cutoffDay: 15 }),
    card('b', 'BAC VISA ₡', 'bac', '4477', 'CRC', { userId: 'u2', cutoffDay: 15 }),
  ];
  const due = dueReminders(both, '2026-10-13');
  assert.deepEqual(due.map((c) => c.userId).sort(), ['u1', 'u2']);
  // Sent to one, still owed to the other.
  assert.equal(dueReminders(both, '2026-10-13', new Set([sentKey(due[0])])).length, 1);
});

test('the reminder says when, in words', () => {
  const at = (daysLeft) => reminderText({ name: 'BAC VISA', daysLeft, cutoffDate: '2026-10-15' }).title;
  assert.equal(at(0), 'BAC VISA closes today');
  assert.equal(at(1), 'BAC VISA closes tomorrow');
  assert.equal(at(3), 'BAC VISA closes in 3 days');
  assert.match(reminderText({ name: 'X', daysLeft: 3, cutoffDate: '2026-10-22' }).body, /22nd/);
  assert.match(reminderText({ name: 'X', daysLeft: 3, cutoffDate: '2026-10-11' }).body, /11th/);
});
