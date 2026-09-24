/**
 * What date a manually added expense gets.
 *
 * Same bug as day-grouping, on the way in rather than the way out: taking the
 * date from an ISO string reads the UTC day, and Costa Rica is six hours
 * behind it. Anything entered after 6pm was dated tomorrow — and on the last
 * evening of a month, dated into the next month, where the charge saved
 * correctly and then could not be seen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankTx } from '../src/views-tx.js';

/** Runs `fn` with the wall clock frozen at `iso`. */
function at(iso, fn) {
  const Real = Date;
  globalThis.Date = class extends Real {
    constructor(...args) { return args.length ? new Real(...args) : new Real(iso); }
    static now() { return new Real(iso).getTime(); }
  };
  try { return fn(); } finally { globalThis.Date = Real; }
}

const dateOf = (tx) => String(tx.postedAt).slice(0, 10);

test('an expense added in the evening is dated today, not tomorrow', () => {
  // 7:30pm on 23 September in Costa Rica — already the 24th in UTC.
  at('2026-09-24T01:30:00Z', () => {
    assert.equal(dateOf(blankTx('2026-09')), '2026-09-23');
  });
});

test('an expense added on the last evening of a month stays in that month', () => {
  // 11:30pm on 30 September — 1 October in UTC. This is the case that made a
  // charge vanish: dated into October while September was on screen.
  at('2026-10-01T05:30:00Z', () => {
    const tx = blankTx('2026-09');
    assert.equal(dateOf(tx), '2026-09-30');
    assert.equal(dateOf(tx).slice(0, 7), '2026-09');
  });
});

test('a midday expense is unaffected', () => {
  at('2026-09-23T18:00:00Z', () => {
    assert.equal(dateOf(blankTx('2026-09')), '2026-09-23');
  });
});

test('adding to a month you are only looking at lands on its first day', () => {
  // Never silently in a month that is not on screen.
  at('2026-09-23T18:00:00Z', () => {
    assert.equal(dateOf(blankTx('2026-07')), '2026-07-01');
  });
});

test('every new expense is its own row', () => {
  at('2026-09-23T18:00:00Z', () => {
    assert.notEqual(blankTx('2026-09').extId, blankTx('2026-09').extId);
  });
});
