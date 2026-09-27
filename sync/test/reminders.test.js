import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReminders } from '../../supabase/functions/_shared/reminders.js';
import { sentKey } from '../../supabase/functions/_shared/cutoff.js';

/** An in-memory stand-in for the database and the push service. */
function world({ cards, devices = {}, sendResult = () => ({ ok: true }) }) {
  const sent = new Map(); // sentKey -> entry
  const pushes = [];
  const removed = [];
  const subs = structuredClone(devices);
  return {
    pushes, removed, sent,
    deps: {
      listCards: async () => cards,
      listSent: async (today) => [...sent.values()].filter((e) => e.cutoffDate >= today),
      listSubscriptions: async (userId) => subs[userId] ?? [],
      claim: async (entry) => {
        const k = sentKey(entry);
        if (sent.has(k)) return false;
        sent.set(k, { userId: entry.userId, cardKey: entry.cardKey, cutoffDate: entry.cutoffDate });
        return true;
      },
      release: async (entry) => { sent.delete(sentKey(entry)); },
      send: async (device, payload) => {
        const r = sendResult(device);
        if (r.ok) pushes.push({ endpoint: device.endpoint, ...payload });
        return r;
      },
      removeSubscription: async (endpoint) => {
        removed.push(endpoint);
        for (const list of Object.values(subs)) {
          const i = list.findIndex((d) => d.endpoint === endpoint);
          if (i >= 0) list.splice(i, 1);
        }
      },
    },
  };
}

const VISA = [
  { id: 'v1', userId: 'u1', label: 'BAC VISA ₡', type: 'card', issuer: 'bac', last4: '4477',
    currency: 'CRC', active: true, cutoffDay: 15, cutoffWarnDays: 3 },
  { id: 'v2', userId: 'u1', label: 'BAC VISA $', type: 'card', issuer: 'bac', last4: '4477',
    currency: 'USD', active: true, cutoffDay: 15, cutoffWarnDays: 3 },
];
const PHONE = { endpoint: 'https://push.example/phone', p256dh: 'k', auth: 'a' };
const LAPTOP = { endpoint: 'https://push.example/laptop', p256dh: 'k', auth: 'a' };

test('sends one reminder per card, to every device, once', async () => {
  const w = world({ cards: VISA, devices: { u1: [PHONE, LAPTOP] } });
  const first = await runReminders(w.deps, '2026-10-13');
  assert.deepEqual(first.sent, ['BAC VISA']);
  // One card, not one per currency half; both devices.
  assert.equal(w.pushes.length, 2);
  assert.equal(w.pushes[0].title, 'BAC VISA closes in 2 days');
  assert.equal(w.pushes[0].tag, 'cutoff:bac:4477:2026-10-15');

  // The next day, still inside the window: nothing new.
  const second = await runReminders(w.deps, '2026-10-14');
  assert.equal(second.due, 0);
  assert.equal(w.pushes.length, 2);
});

test('nothing is sent outside the window', async () => {
  const w = world({ cards: VISA, devices: { u1: [PHONE] } });
  const r = await runReminders(w.deps, '2026-10-01');
  assert.equal(r.due, 0);
  assert.equal(w.pushes.length, 0);
});

test('with no device subscribed, the reminder stays owed', async () => {
  const w = world({ cards: VISA, devices: {} });
  const r = await runReminders(w.deps, '2026-10-12');
  assert.deepEqual(r.noDevice, ['BAC VISA']);
  assert.equal(w.sent.size, 0, 'not recorded as sent');
});

test('a reminder that reached no device is retried on the next run', async () => {
  let down = true;
  const w = world({
    cards: VISA,
    devices: { u1: [PHONE] },
    sendResult: () => (down ? { ok: false, gone: false, error: 'push service 503' } : { ok: true }),
  });
  const failed = await runReminders(w.deps, '2026-10-12');
  assert.equal(failed.failed.length, 1);
  assert.equal(w.sent.size, 0, 'the claim was taken back');

  down = false;
  const retried = await runReminders(w.deps, '2026-10-13');
  assert.deepEqual(retried.sent, ['BAC VISA']);
});

test('a device that has gone away is removed, and the others still get it', async () => {
  const w = world({
    cards: VISA,
    devices: { u1: [PHONE, LAPTOP] },
    sendResult: (d) => (d === undefined || d.endpoint === LAPTOP.endpoint
      ? { ok: false, gone: true, error: '410' } : { ok: true }),
  });
  const r = await runReminders(w.deps, '2026-10-12');
  assert.deepEqual(w.removed, [LAPTOP.endpoint]);
  assert.equal(r.removedDevices, 1);
  assert.deepEqual(r.sent, ['BAC VISA']);
});

test('two runs racing send it once: the claim decides', async () => {
  const w = world({ cards: VISA, devices: { u1: [PHONE] } });
  // Both runs read "not sent yet" before either claims.
  const [a, b] = await Promise.all([
    runReminders(w.deps, '2026-10-12'),
    runReminders(w.deps, '2026-10-12'),
  ]);
  assert.equal(w.pushes.length, 1);
  assert.equal(a.sent.length + b.sent.length, 1);
});
