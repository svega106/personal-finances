/**
 * The date repair.
 *
 * This is the one path allowed to write over a charge that is already in the
 * table, so what it must NOT touch matters more than what it does. These
 * record the whole contract: one column, matched on ext_id and user, only
 * where the value differs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairPostedAt } from '../../supabase/functions/_shared/repair.js';

/**
 * A stand-in for supabase-js that records what was asked of it.
 *
 * `table` is the pretend contents; a query returns the rows that match every
 * filter, which is what makes the `.neq` on posted_at testable rather than
 * merely present.
 */
function fakeDb(table, { failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    from(name) {
      const call = { table: name, patch: null, eq: {}, neq: {}, selected: null };
      calls.push(call);
      const q = {
        update(patch) { call.patch = patch; return q; },
        eq(col, val) { call.eq[col] = val; return q; },
        neq(col, val) { call.neq[col] = val; return q; },
        select(cols) {
          call.selected = cols;
          if (failWith) return Promise.resolve({ data: null, error: { message: failWith } });
          const hit = table.filter((row) =>
            Object.entries(call.eq).every(([c, v]) => row[c] === v) &&
            Object.entries(call.neq).every(([c, v]) => row[c] !== v));
          for (const row of hit) Object.assign(row, call.patch);
          return Promise.resolve({ data: hit, error: null });
        },
      };
      return q;
    },
  };
}

const U = 'user-1';
const stored = () => ([
  // Reviewed by hand, so noon of the UTC day — a day late, because the
  // charge was at 21:29 Costa Rica.
  { id: 'a', user_id: U, ext_id: 'bac:9654:157481:t202609242129',
    merchant_raw: 'SPOTIFY', posted_at: '2026-09-25T18:00:00+00:00', cat: 'wants',
    merchant: 'Spotify', reimbursement: null, account_id: 'acct-1', reviewed: true },
  // Never reviewed, so still correct.
  { id: 'b', user_id: U, ext_id: 'davivienda:5131:441124:626711201980',
    merchant_raw: 'TERADYNE HEREDIA CR', posted_at: '2026-09-24T17:20:00+00:00', cat: 'needs',
    merchant: 'Teradyne', reimbursement: null, account_id: 'acct-2', reviewed: false },
]);

const parsed = [
  { ext_id: 'bac:9654:157481:t202609242129', merchant_raw: 'SPOTIFY',
    posted_at: '2026-09-24T21:29:00-06:00', cat: null, merchant: 'SPOTIFY' },
  { ext_id: 'davivienda:5131:441124:626711201980', merchant_raw: 'TERADYNE HEREDIA CR',
    posted_at: '2026-09-24T17:20:00+00:00', cat: null, merchant: 'TERADYNE HEREDIA CR' },
];

test('a charge that was moved gets its real timestamp back', async () => {
  const table = stored();
  const db = fakeDb(table);
  const { changed, alreadyCorrect } = await repairPostedAt(db, U, parsed);

  assert.equal(changed.length, 1);
  assert.equal(changed[0].merchant, 'SPOTIFY');
  assert.equal(table[0].posted_at, '2026-09-24T21:29:00-06:00');
  assert.equal(alreadyCorrect, 1);
});

test('nothing but the timestamp is in the update', async () => {
  const db = fakeDb(stored());
  await repairPostedAt(db, U, parsed);
  for (const call of db.calls) {
    assert.deepEqual(Object.keys(call.patch), ['posted_at']);
  }
});

test('a hand-made categorization survives', async () => {
  const table = stored();
  await repairPostedAt(fakeDb(table), U, parsed);
  assert.equal(table[0].cat, 'wants');
  assert.equal(table[0].merchant, 'Spotify');
  assert.equal(table[0].account_id, 'acct-1');
  assert.equal(table[0].reviewed, true);
});

test('it is scoped to the user and the charge', async () => {
  const db = fakeDb(stored());
  await repairPostedAt(db, U, parsed);
  assert.equal(db.calls[0].table, 'transactions');
  assert.equal(db.calls[0].eq.user_id, U);
  assert.equal(db.calls[0].eq.ext_id, parsed[0].ext_id);
});

test('a charge belonging to nobody else is touched', async () => {
  const table = stored();
  table.push({ ...table[0], id: 'c', user_id: 'someone-else',
               posted_at: '2026-09-25T18:00:00+00:00' });
  await repairPostedAt(fakeDb(table), U, parsed);
  assert.equal(table[2].posted_at, '2026-09-25T18:00:00+00:00');
});

test('running it twice reports the second run as nothing to do', async () => {
  const table = stored();
  await repairPostedAt(fakeDb(table), U, parsed);
  const second = await repairPostedAt(fakeDb(table), U, parsed);
  assert.equal(second.changed.length, 0);
  assert.equal(second.alreadyCorrect, 2);
});

test('a charge that never imported is not an error', async () => {
  const { changed, alreadyCorrect } = await repairPostedAt(fakeDb([]), U, parsed);
  assert.equal(changed.length, 0);
  assert.equal(alreadyCorrect, 2);
});

test('a database error stops the run rather than being counted as a repair', async () => {
  const db = fakeDb(stored(), { failWith: 'permission denied' });
  await assert.rejects(() => repairPostedAt(db, U, parsed), /permission denied/);
});
