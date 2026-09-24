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
