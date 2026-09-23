/**
 * Which calendar day a charge belongs to.
 *
 * Postgres returns `timestamptz` normalized to UTC. Slicing that string gives
 * the UTC date, so every charge after 6pm in Costa Rica was filed under the
 * next day: evenings were split across two headings and an 8pm charge sorted
 * below a midday one. These are the real timestamps that exposed it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, dayLabel } from '../src/views-tx.js';

test('an evening charge stays on the day it was made', () => {
  // Auto Mercado, 8:38pm on Monday 21 September, as Postgres returns it.
  assert.equal(dayKey('2026-09-22T02:38:00+00:00'), '2026-09-21');
});

test('the same instant written in local time agrees', () => {
  assert.equal(dayKey('2026-09-21T20:38:00-06:00'), '2026-09-21');
});

test('a midday charge is unaffected', () => {
  assert.equal(dayKey('2026-09-21T18:34:00+00:00'), '2026-09-21');
});

test('just before local midnight stays on the local day', () => {
  // Pizza Hub, 11:51pm on 15 September.
  assert.equal(dayKey('2026-09-16T05:51:00+00:00'), '2026-09-15');
});

test('one evening groups into one day, not two', () => {
  const evening = [
    '2026-09-22T02:38:00+00:00', // 8:38pm
    '2026-09-21T23:15:00+00:00', // 5:15pm
    '2026-09-21T18:34:00+00:00', // 12:34pm
  ];
  assert.equal(new Set(evening.map(dayKey)).size, 1);
});

test('the heading matches the day it groups', () => {
  assert.equal(dayLabel('2026-09-21'), 'Mon, Sep 21');
  assert.equal(dayLabel('2026-09-15'), 'Tue, Sep 15');
});

test('a label is not dragged back a day by UTC midnight', () => {
  // `new Date('2026-09-01')` is UTC midnight, which is 31 August in Costa
  // Rica. Building the label at local noon is what avoids that.
  assert.equal(dayLabel('2026-09-01'), 'Tue, Sep 1');
  assert.equal(dayLabel('2026-01-01'), 'Thu, Jan 1');
});
