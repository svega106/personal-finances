/**
 * New-charge notifications: which rows are announced, what each says, and
 * how they reach the devices — with the push service stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chargeAlerts, sendChargeAlerts, freshCharges, formatAmount, FRESH_HOURS, MAX_SINGLE,
} from '../../supabase/functions/_shared/charge-alerts.js';

const NOW = new Date('2026-09-29T20:00:00-06:00');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60e3).toISOString();

const VISA = { id: 'a-visa', label: 'BAC VISA ₡', last4: '4477', scope: 'personal' };
const VISA_USD = { id: 'a-visa-usd', label: 'BAC VISA $', last4: '4477', scope: 'personal' };
const BNCR = { id: 'a-bncr', label: 'BNCR VISA ₡ (work)', last4: '0828', scope: 'work' };
const ACCOUNTS = [VISA, VISA_USD, BNCR];

let seq = 0;
const charge = (over = {}) => ({
  id: `t${++seq}`, kind: 'expense', status: 'settled', posted_at: ago(10),
  merchant: 'Auto Mercado', merchant_raw: 'AUTO MERCADO HEREDIA', amount: 38500, currency: 'CRC',
  account_id: 'a-visa', scope: 'personal', cat: null, ...over,
});

/* ------------------------------------------------------- what is announced */

test('amounts read the way the app writes them', () => {
  assert.equal(formatAmount(38500, 'CRC'), '₡38,500');
  assert.equal(formatAmount(38500.4, 'CRC'), '₡38,500');
  assert.equal(formatAmount(4.99, 'USD'), '$4.99');
  assert.equal(formatAmount(1234.5, 'USD'), '$1,234.50');
});

test('one notification per new charge, saying what, where and what next', () => {
  const [a] = chargeAlerts([charge({ id: 'x1' })], ACCOUNTS, NOW);
  assert.deepEqual(a, {
    kind: 'charge',
    title: '₡38,500 at Auto Mercado',
    body: 'BAC VISA ₡ ••4477 · Tap to categorize',
    tag: 'charge:x1',
    url: '/?view=transactions&tx=x1',
  });
});

test('a categorized charge says its category; a dollar one its dollars', () => {
  const [a, b] = chargeAlerts([
    charge({ cat: 'needs', posted_at: ago(30) }),
    charge({ merchant: 'Netflix', amount: 4.99, currency: 'USD', account_id: 'a-visa-usd', cat: 'wants' }),
  ], ACCOUNTS, NOW);
  assert.equal(a.body, 'BAC VISA ₡ ••4477 · Essentials');
  assert.equal(b.title, '$4.99 at Netflix');
  assert.equal(b.body, 'BAC VISA $ ••4477 · Discretionary');
});

test("the company's card, a work charge, and a card the app does not know", () => {
  const [company, work, unknown] = chargeAlerts([
    charge({ account_id: 'a-bncr', scope: 'work', posted_at: ago(30) }),
    charge({ scope: 'work', posted_at: ago(20) }),
    charge({ account_id: null, merchant: null, posted_at: ago(10) }),
  ], ACCOUNTS, NOW);
  assert.equal(company.body, 'BNCR VISA ₡ (work) ••0828 · Paid by the company');
  assert.equal(work.body, 'BAC VISA ₡ ••4477 · Work — to be reimbursed');
  assert.equal(unknown.title, '₡38,500 at AUTO MERCADO HEREDIA', 'the raw name when there is no clean one');
  assert.equal(unknown.body, 'A card the app does not know yet · Tap to categorize');
});

test('oldest first, so the newest ends on top', () => {
  const alerts = chargeAlerts([
    charge({ id: 'late', posted_at: ago(5) }),
    charge({ id: 'early', posted_at: ago(50) }),
  ], ACCOUNTS, NOW);
  assert.deepEqual(alerts.map((a) => a.tag), ['charge:early', 'charge:late']);
});

test('a re-imported old charge is history, not news', () => {
  const rows = [
    charge({ id: 'old', posted_at: ago(FRESH_HOURS * 60 + 1) }),
    charge({ id: 'new', posted_at: ago(FRESH_HOURS * 60 - 1) }),
  ];
  assert.deepEqual(freshCharges(rows, NOW).map((r) => r.id), ['new']);
  assert.deepEqual(chargeAlerts([rows[0]], ACCOUNTS, NOW), []);
});

test('only purchases: not a voided one, not income or a transfer', () => {
  const rows = [
    charge({ status: 'voided' }), charge({ kind: 'income' }), charge({ kind: 'transfer' }),
  ];
  assert.deepEqual(chargeAlerts(rows, ACCOUNTS, NOW), []);
});

test('a batch arrives as one summary, newest named first', () => {
  const rows = Array.from({ length: MAX_SINGLE + 2 }, (_, i) =>
    charge({ id: `b${i}`, merchant: `Shop ${i}`, amount: 1000 * (i + 1), posted_at: ago(60 - i) }));
  const alerts = chargeAlerts(rows, ACCOUNTS, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, '5 new charges');
  assert.equal(alerts[0].body, 'Shop 4 ₡5,000 · Shop 3 ₡4,000 · Shop 2 ₡3,000 · and 2 more');
  assert.equal(alerts[0].url, '/?view=transactions');
  // Exactly MAX_SINGLE still arrive one by one.
  assert.equal(chargeAlerts(rows.slice(0, MAX_SINGLE), ACCOUNTS, NOW).length, MAX_SINGLE);
});

test('nothing inserted, nothing announced', () => {
  assert.deepEqual(chargeAlerts([], ACCOUNTS, NOW), []);
  assert.deepEqual(chargeAlerts(undefined, ACCOUNTS, NOW), []);
});

/* ------------------------------------------------------------- delivering */

const PHONE = { endpoint: 'https://push.example/phone', p256dh: 'k', auth: 'a' };
const LAPTOP = { endpoint: 'https://push.example/laptop', p256dh: 'k', auth: 'a' };

function world({ devices = [PHONE, LAPTOP], result = () => ({ ok: true }), listFails = false } = {}) {
  const sent = [];
  const removed = [];
  const asked = [];
  return {
    sent, removed, asked,
    deps: {
      listSubscriptions: async (userId, kind) => {
        asked.push([userId, kind]);
        if (listFails) throw new Error('database down');
        return devices;
      },
      send: async (device, payload) => {
        const r = result(device, payload);
        if (r.ok) sent.push([device.endpoint, payload.tag]);
        return r;
      },
      removeSubscription: async (endpoint) => { removed.push(endpoint); },
    },
  };
}

const TWO = chargeAlerts([charge({ id: 'c1', posted_at: ago(20) }), charge({ id: 'c2' })], ACCOUNTS, NOW);

test('every alert goes to every device that has new charges switched on', async () => {
  const w = world();
  const r = await sendChargeAlerts(w.deps, 'u1', TWO);
  assert.deepEqual(w.asked, [['u1', 'charges']]);
  assert.equal(w.sent.length, 4);
  assert.deepEqual(r, { alerts: 2, devices: 2, delivered: 4, removedDevices: 0, errors: [] });
});

test('a device that is gone is removed once, and not tried again', async () => {
  const w = world({ result: (d) => (d === LAPTOP ? { ok: false, gone: true, error: '410 Gone' } : { ok: true }) });
  const r = await sendChargeAlerts(w.deps, 'u1', TWO);
  assert.deepEqual(w.removed, [LAPTOP.endpoint]);
  assert.deepEqual(w.sent.map(([e]) => e), [PHONE.endpoint, PHONE.endpoint]);
  assert.equal(r.removedDevices, 1);
  assert.equal(r.delivered, 2);
});

test('a failing push service is reported, not thrown', async () => {
  const w = world({ result: () => ({ ok: false, gone: false, error: '500 upstream' }) });
  const r = await sendChargeAlerts(w.deps, 'u1', TWO);
  assert.equal(r.delivered, 0);
  assert.equal(r.errors.length, 4);
  assert.deepEqual(w.removed, []);
});

test('a database error is reported, not thrown — the import already succeeded', async () => {
  const w = world({ listFails: true });
  const r = await sendChargeAlerts(w.deps, 'u1', TWO);
  assert.deepEqual(r.errors, ['database down']);
  assert.equal(r.delivered, 0);
});

test('no alerts: the database is not even asked', async () => {
  const w = world();
  const r = await sendChargeAlerts(w.deps, 'u1', []);
  assert.deepEqual(w.asked, []);
  assert.equal(r.alerts, 0);
});

test('no devices switched on: nothing sent, nothing wrong', async () => {
  const w = world({ devices: [] });
  const r = await sendChargeAlerts(w.deps, 'u1', TWO);
  assert.equal(r.devices, 0);
  assert.equal(w.sent.length, 0);
  assert.deepEqual(r.errors, []);
});
