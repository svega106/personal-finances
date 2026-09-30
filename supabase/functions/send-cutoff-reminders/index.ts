/**
 * Sends a push reminder ahead of each credit card's billing cutoff.
 *
 * Called once a day by the same Apps Script that runs the email sync, with
 * the same shared secret — nothing else in this stack runs on a schedule.
 * Every decision (which cards, which day, whether it was already sent) is in
 * _shared/reminders.js and _shared/cutoff.js, under node tests; this file is
 * the wiring to the database and the push service.
 *
 * Deploy:  npx supabase functions deploy send-cutoff-reminders --no-verify-jwt
 *
 * Secrets: INGEST_SECRET, the one the sync already uses, and the VAPID trio
 * described in _shared/web-push.ts.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { runReminders } from '../_shared/reminders.js';
import { vapidProblem, createSender, type Device } from '../_shared/web-push.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SECRET = Deno.env.get('INGEST_SECRET') ?? '';

/** Constant time, as in ingest-email: `===` on a secret leaks it by timing. */
function secretOk(given: string): boolean {
  if (!SECRET || !given) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(SECRET);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Entry = { userId: string; cardKey: string; cutoffDate: string };

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!secretOk(req.headers.get('x-ingest-secret') ?? '')) return json({ error: 'unauthorized' }, 401);

  const problem = vapidProblem();
  if (problem) return json({ error: problem }, 500);
  // A reminder still matters a day later; the cutoff is days away.
  const send = createSender({ ttlSeconds: 24 * 3600 });

  // The day in Costa Rica. `{ "today": "YYYY-MM-DD" }` overrides it, which is
  // how a reminder is tried out without waiting for its cutoff.
  let body: { today?: string } = {};
  try { body = await req.json(); } catch { /* an empty body is fine */ }
  const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today ?? '')
    ? body.today!
    : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });

  const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const fail = (what: string, error: { message: string }) => {
    throw new Error(`${what}: ${error.message}`);
  };

  const deps = {
    async listCards() {
      const { data, error } = await db.from('accounts')
        .select('id, user_id, label, type, issuer, last4, default_currency, active, cutoff_day, cutoff_warn_days')
        .eq('type', 'card').eq('active', true).not('cutoff_day', 'is', null);
      if (error) fail('accounts', error);
      return (data ?? []).map((a) => ({
        id: a.id, userId: a.user_id, label: a.label, type: a.type, issuer: a.issuer,
        last4: a.last4, currency: a.default_currency, active: a.active,
        cutoffDay: a.cutoff_day, cutoffWarnDays: a.cutoff_warn_days,
      }));
    },
    async listSent(from: string) {
      const { data, error } = await db.from('cutoff_reminders_sent')
        .select('user_id, card_key, cutoff_date').gte('cutoff_date', from);
      if (error) fail('reminders sent', error);
      return (data ?? []).map((r) => ({ userId: r.user_id, cardKey: r.card_key, cutoffDate: r.cutoff_date }));
    },
    async listSubscriptions(userId: string) {
      // Only devices that still want reminders; each is switched separately
      // in the app's Settings (0012).
      const { data, error } = await db.from('push_subscriptions')
        .select('endpoint, p256dh, auth').eq('user_id', userId).eq('notify_cutoffs', true);
      if (error) fail('subscriptions', error);
      return data ?? [];
    },
    async claim(e: Entry) {
      const { error } = await db.from('cutoff_reminders_sent')
        .insert({ user_id: e.userId, card_key: e.cardKey, cutoff_date: e.cutoffDate });
      if (!error) return true;
      if (error.code === '23505') return false; // another run already has it
      fail('record reminder', error);
    },
    async release(e: Entry) {
      const { error } = await db.from('cutoff_reminders_sent').delete()
        .eq('user_id', e.userId).eq('card_key', e.cardKey).eq('cutoff_date', e.cutoffDate);
      if (error) fail('release reminder', error);
    },
    send: (d: Device, payload: unknown) => send(d, payload),
    async removeSubscription(endpoint: string) {
      const { error } = await db.from('push_subscriptions').delete().eq('endpoint', endpoint);
      if (error) fail('remove subscription', error);
    },
  };

  try {
    return json({ ok: true, ...(await runReminders(deps, today)) });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
