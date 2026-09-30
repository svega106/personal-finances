/**
 * When the app reloads by itself: a changed ledger, a new-charge
 * notification, coming back to it — and never under someone mid-edit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLive, RESUME_AFTER_MS } from '../src/live-core.js';
import { createMemoryRepo } from '../src/memory-repo.js';

/** A ledger whose marker is set by hand, and reloads that note what they load. */
function harness({ busy = false } = {}) {
  const h = {
    marker: 'm1', busy, clock: 0,
    calls: [],
    live: null,
  };
  h.live = createLive({
    marker: async () => h.marker,
    // As refresh.js does: a reload first tells live what it is about to load.
    refreshLedger: async () => { h.live.adopt(); h.calls.push('ledger'); },
    refreshAll: async () => { h.live.adopt(); h.calls.push('all'); },
    busy: () => h.busy,
    now: () => h.clock,
  });
  return h;
}

test('the first check only learns what the screen shows', async () => {
  const h = harness();
  assert.equal(await h.live.tick(), false);
  assert.deepEqual(h.calls, []);
});

test('an unchanged ledger is left alone; a changed one is reloaded once', async () => {
  const h = harness();
  await h.live.tick();
  await h.live.tick();
  assert.deepEqual(h.calls, []);

  h.marker = 'm2'; // the sync inserted a charge
  assert.equal(await h.live.tick(), true);
  assert.deepEqual(h.calls, ['ledger']);

  await h.live.tick();
  await h.live.tick();
  assert.deepEqual(h.calls, ['ledger'], 'the reload noted m2, so it is not reloaded again');
});

test('a change made in the app itself is not reloaded a second time', async () => {
  const h = harness();
  await h.live.tick();
  // Saving a charge reloads through refresh.js, which calls adopt first.
  h.marker = 'm2';
  await h.live.adopt();
  await h.live.tick();
  assert.deepEqual(h.calls, []);
});

test('a new-charge notification reloads straight away', async () => {
  const h = harness();
  await h.live.pushed();
  assert.deepEqual(h.calls, ['ledger']);
});

test('while a sheet is open it waits, then reloads once it closes', async () => {
  const h = harness();
  await h.live.tick();
  h.busy = true;
  h.marker = 'm2';
  assert.equal(await h.live.tick(), false);
  assert.equal(h.live.pending, 'ledger');
  assert.equal(await h.live.pushed(), false, 'a notification waits too');
  await h.live.tick();
  assert.deepEqual(h.calls, [], 'still open: still waiting');

  h.busy = false;
  assert.equal(await h.live.tick(), true);
  assert.deepEqual(h.calls, ['ledger'], 'once, not once per thing that asked');
  assert.equal(h.live.pending, null);
});

test('back after a real absence reloads everything; a quick look only checks', async () => {
  const h = harness();
  await h.live.tick();

  h.live.hidden();
  h.clock += RESUME_AFTER_MS - 1;
  await h.live.visible();
  assert.deepEqual(h.calls, [], 'a few seconds away, nothing changed: nothing reloaded');

  h.live.hidden();
  h.clock += RESUME_AFTER_MS;
  await h.live.visible();
  assert.deepEqual(h.calls, ['all'], 'the budget may have changed on another device too');
});

test('a quick look still catches a charge that arrived meanwhile', async () => {
  const h = harness();
  await h.live.tick();
  h.live.hidden();
  h.clock += 10_000;
  h.marker = 'm2';
  await h.live.visible();
  assert.deepEqual(h.calls, ['ledger']);
});

test('reloading everything wins over the ledger when both are waiting', async () => {
  const h = harness();
  await h.live.tick();
  h.busy = true;
  await h.live.pushed();
  h.live.hidden();
  h.clock += RESUME_AFTER_MS;
  await h.live.visible();
  assert.equal(h.live.pending, 'all');
  h.busy = false;
  await h.live.tick();
  assert.deepEqual(h.calls, ['all']);
});

test('a notification during a reload is not lost, and not doubled', async () => {
  let release;
  const calls = [];
  const live = createLive({
    marker: async () => 'm',
    refreshLedger: () => new Promise((resolve) => { calls.push('ledger'); release = resolve; }),
    refreshAll: async () => {},
  });
  const first = live.pushed();
  await live.pushed(); // arrives while the first reload is still loading
  await live.pushed();
  release();
  await new Promise((r) => setImmediate(r)); // the queued reload has started
  release();
  await first;
  assert.deepEqual(calls, ['ledger', 'ledger'], 'the one in flight, then one more for everything that came in');
});

test('a failed reload or an unreachable server is shrugged off', async () => {
  let fail = true;
  const calls = [];
  const live = createLive({
    marker: async () => { if (fail) throw new Error('offline'); return 'm'; },
    refreshLedger: async () => { calls.push('ledger'); if (fail) throw new Error('offline'); },
    refreshAll: async () => {},
  });
  assert.equal(await live.tick(), false, 'no marker, no reload, no throw');
  assert.equal(await live.pushed(), true, 'the reload failed quietly');
  fail = false;
  await live.pushed();
  assert.deepEqual(calls, ['ledger', 'ledger']);
});

test('an answer that arrives late never replaces a newer one', async () => {
  const answers = [];
  const calls = [];
  const live = createLive({
    marker: () => new Promise((resolve) => answers.push(resolve)),
    refreshLedger: async () => { calls.push('ledger'); },
    refreshAll: async () => {},
  });
  const older = live.adopt();
  const newer = live.adopt();
  answers[1]('m2');
  await newer;
  answers[0]('m1'); // the slow, stale read
  await older;

  const check = live.tick();
  answers[2]('m2');
  await check;
  assert.deepEqual(calls, [], 'the screen was known to show m2 all along');
});

test('the in-memory ledger marker moves with every write', async () => {
  const repo = createMemoryRepo({});
  const before = await repo.ledgerMarker();
  const t = await repo.upsertTransaction({ extId: 'e1', kind: 'expense', amount: 1, currency: 'CRC', postedAt: '2026-09-29T10:00:00-06:00' });
  const added = await repo.ledgerMarker();
  await repo.upsertTransaction({ ...t, amount: 2 });
  const edited = await repo.ledgerMarker();
  await repo.deleteTransaction(t.id);
  const removed = await repo.ledgerMarker();
  assert.equal(new Set([before, added, edited, removed]).size, 4);
});

test("a device's notification kinds: both on until changed, one at a time", async () => {
  const repo = createMemoryRepo({});
  await repo.savePushSubscription({ endpoint: 'https://push.example/phone', p256dh: 'k', auth: 'a' });
  assert.deepEqual(await repo.getPushPrefs('https://push.example/phone'), { charges: true, cutoffs: true });
  await repo.savePushPrefs('https://push.example/phone', { cutoffs: false });
  assert.deepEqual(await repo.getPushPrefs('https://push.example/phone'), { charges: true, cutoffs: false });
  assert.equal(await repo.getPushPrefs('https://push.example/unknown'), null);
});
