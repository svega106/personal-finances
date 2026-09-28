/**
 * What a save writes back, and what it must never quietly drop.
 *
 * The bug: the edit sheet showed the card fields for savings and cash
 * accounts but not for cards, because a card's number is its own identity
 * rather than something attached to it. The save path read those inputs
 * anyway, got '' back because they were not on the page, and wrote issuer and
 * last4 as null. Renaming a card erased the number the email sync matches on,
 * and the next day's charges arrived belonging to nothing.
 *
 * The rule these pin down: a field the form did not offer is unchanged, never
 * cleared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountPatch } from '../src/account-patch.js';

const CARD = {
  id: 'c1', label: 'BAC VISA ₡', type: 'card', currency: 'CRC',
  issuer: 'bac', brand: 'visa', last4: '4477', scope: 'personal',
};
const SAVINGS = {
  id: 's1', label: 'Ahorros ₡', type: 'savings', currency: 'CRC',
  issuer: 'bac', brand: 'mastercard', last4: '2207', scope: 'personal',
};

test('renaming a card keeps its number when the form did not offer it', () => {
  const { row, error } = accountPatch(CARD, { label: 'BAC Dorada Colones', institution: '' });
  assert.equal(error, undefined);
  assert.equal(row.issuer, 'bac');
  assert.equal(row.last4, '4477');
  assert.equal(row.brand, 'visa');
});

test('renaming a card keeps its number when the form offers it unchanged', () => {
  const { row } = accountPatch(CARD, {
    label: 'BAC Dorada Colones', institution: '', issuer: 'bac', last4: '4477',
  });
  assert.equal(row.issuer, 'bac');
  assert.equal(row.last4, '4477');
});

test('a card cannot be saved without its number', () => {
  const { row, error } = accountPatch(CARD, {
    label: 'BAC Dorada Colones', institution: '', issuer: '', last4: '',
  });
  assert.equal(row, undefined);
  assert.match(error, /last 4/i);
});

test('the card can still be corrected when a card is reissued', () => {
  const { row } = accountPatch(CARD, {
    label: 'BAC Dorada Colones', institution: '', issuer: 'bac', last4: '9012',
  });
  assert.equal(row.last4, '9012');
});

test('a savings account may drop its card deliberately', () => {
  // Here the form did offer the fields, and they were emptied on purpose.
  const { row, error } = accountPatch(SAVINGS, {
    label: 'Ahorros Colones', institution: '', issuer: '', last4: '',
  });
  assert.equal(error, undefined);
  assert.equal(row.issuer, null);
  assert.equal(row.last4, null);
  assert.equal(row.brand, null);
});

test('a savings account keeps its card through a rename', () => {
  const { row } = accountPatch(SAVINGS, {
    label: 'Ahorros Colones', institution: '', issuer: 'bac', last4: '2207',
  });
  assert.equal(row.last4, '2207');
  assert.equal(row.brand, 'mastercard');
});

test('an account keeps its currency, type and scope whatever the form says', () => {
  const { row } = accountPatch(
    { ...CARD, scope: 'work' },
    { label: 'BNCR', institution: '', type: 'savings', currency: 'USD', issuer: 'bncr', last4: '0828' });
  assert.equal(row.type, 'card');
  assert.equal(row.currency, 'CRC');
  assert.equal(row.scope, 'work');
});

test('a new account takes the currency it was given', () => {
  const { row } = accountPatch(null, {
    label: 'Ahorros nuevo', institution: 'BAC', type: 'savings', currency: 'USD',
    issuer: '', last4: '',
  });
  assert.equal(row.currency, 'USD');
  assert.equal(row.type, 'savings');
  assert.equal(row.id, undefined);
});

test('a half-entered card is refused rather than half-saved', () => {
  assert.match(accountPatch(SAVINGS, { label: 'x', issuer: 'bac', last4: '12' }).error, /last 4/i);
  assert.match(accountPatch(SAVINGS, { label: 'x', issuer: '', last4: '1234' }).error, /which bank/i);
});

test('a name is still required', () => {
  assert.match(accountPatch(CARD, { label: '   ' }).error, /name/i);
});

test('digits are taken from however they were typed', () => {
  const { row } = accountPatch(CARD, { label: 'x', issuer: 'bac', last4: '··4477' });
  assert.equal(row.last4, '4477');
});

/* ------------------------------------------------------------ cutoffs */

test('a card takes a cutoff day and its own warning days', () => {
  const { row, error } = accountPatch(CARD, { label: CARD.label, cutoffDay: '15', cutoffWarnDays: '5' });
  assert.equal(error, undefined);
  assert.equal(row.cutoffDay, 15);
  assert.equal(row.cutoffWarnDays, 5);
});

test('a cutoff the form did not offer is kept, like the card number', () => {
  const withCutoff = { ...CARD, cutoffDay: 15, cutoffWarnDays: 5 };
  const { row } = accountPatch(withCutoff, { label: 'Renamed' });
  assert.equal(row.cutoffDay, 15);
  assert.equal(row.cutoffWarnDays, 5);
});

test('clearing the cutoff day removes it; clearing the warning restores 3', () => {
  const withCutoff = { ...CARD, cutoffDay: 15, cutoffWarnDays: 5 };
  const { row } = accountPatch(withCutoff, { label: CARD.label, cutoffDay: '', cutoffWarnDays: '' });
  assert.equal(row.cutoffDay, null);
  assert.equal(row.cutoffWarnDays, 3);
});

test('a cutoff outside 1–31, or a warning outside 0–31, is refused', () => {
  for (const cutoffDay of ['0', '32', '15.5', 'x']) {
    assert.match(accountPatch(CARD, { label: 'x', cutoffDay }).error, /1 to 31/, cutoffDay);
  }
  for (const cutoffWarnDays of ['-1', '32', '2.5']) {
    assert.match(accountPatch(CARD, { label: 'x', cutoffWarnDays }).error, /0 and 31/, cutoffWarnDays);
  }
  assert.equal(accountPatch(CARD, { label: 'x', cutoffWarnDays: '0' }).row.cutoffWarnDays, 0);
});

test('the debit card on a savings account never gets a cutoff', () => {
  // Ahorros ₡ carries BAC Mastercard 2207, a debit card: no bill, no cutoff.
  const { row } = accountPatch(SAVINGS, { label: SAVINGS.label, cutoffDay: '20' });
  assert.equal(row.cutoffDay, null);
});

test('saving an account keeps its place in the list', () => {
  const { row } = accountPatch({ ...CARD, sortOrder: 10 }, { label: 'Renamed' });
  assert.equal(row.sortOrder, 10);
});

/* ------------------------------------------------ adding and removing cards */

test('a new card keeps who pays it and its network', () => {
  const { row } = accountPatch(null, {
    label: 'Scotia VISA ₡', type: 'card', currency: 'CRC', issuer: 'other', last4: '9911',
    brand: 'visa', scope: 'work', cutoffDay: '12', cutoffWarnDays: '4',
  });
  assert.equal(row.type, 'card');
  assert.equal(row.scope, 'work');
  assert.equal(row.brand, 'visa');
  assert.equal(row.issuer, 'other');
  assert.equal(row.cutoffDay, 12);
  assert.equal(accountPatch(null, { label: 'x', type: 'card', issuer: 'bac', last4: '1234' }).row.scope, 'personal');
});

test('an existing savings account cannot be turned into a card', () => {
  const savings = { id: 's', label: 'Ahorros', type: 'savings', currency: 'CRC', scope: 'personal' };
  assert.match(accountPatch(savings, { label: 'Ahorros', type: 'card', issuer: 'bac', last4: '1234' }).error,
    /cannot become a card/);
});

test("a card's network changes only when the form offers it", () => {
  const card = { id: 'c', label: 'BAC VISA ₡', type: 'card', currency: 'CRC', scope: 'personal',
    issuer: 'bac', last4: '4477', brand: 'visa' };
  assert.equal(accountPatch(card, { label: 'BAC VISA ₡' }).row.brand, 'visa', 'absent is unchanged');
  assert.equal(accountPatch(card, { label: 'BAC VISA ₡', brand: 'mastercard' }).row.brand, 'mastercard');
  assert.equal(accountPatch(card, { label: 'BAC VISA ₡', brand: '' }).row.brand, null);
  assert.equal(accountPatch(card, { label: 'BAC VISA ₡', scope: 'work' }).row.scope, 'personal',
    'who pays is fixed once the card exists');
});
