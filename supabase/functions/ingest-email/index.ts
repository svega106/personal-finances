/**
 * Turns bank notification emails into transactions.
 *
 * Apps Script running inside the Gmail account posts raw messages here; this
 * parses them, works out which card each belongs to, categorizes them, and
 * writes them to Postgres. It runs as an Edge Function rather than on
 * Cloudflare so the service-role key never leaves Supabase — the frontend
 * Worker serves static assets only and holds no secrets at all.
 *
 * Deploy:  npx supabase functions deploy ingest-email --no-verify-jwt
 *
 * `--no-verify-jwt` is deliberate. The caller is a script, not a signed-in
 * person, so there is no user JWT to check; authentication is the shared
 * secret below instead.
 *
 * Each charge it inserts is also announced on the devices that have new-charge
 * notifications on (_shared/charge-alerts.js). That needs the VAPID secrets
 * described in _shared/web-push.ts; without them the import works as before
 * and the response says why nothing was sent.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { parseEmail } from '../_shared/parsers.js';
import { matchRule } from '../_shared/classify.js';
import { toTransactionRow, findAccount } from '../_shared/to-row.js';
import { repairPostedAt } from '../_shared/repair.js';
import { chargeAlerts, sendChargeAlerts } from '../_shared/charge-alerts.js';
import { vapidProblem, createSender } from '../_shared/web-push.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const INGEST_SECRET = Deno.env.get('INGEST_SECRET') ?? '';

/**
 * Compares in constant time. A plain `===` on a secret leaks its length and,
 * over enough tries, its contents through timing.
 */
function secretOk(given: string): boolean {
  if (!INGEST_SECRET || !given) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(INGEST_SECRET);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

type Incoming = { id?: string; from: string; subject?: string; body?: string; html?: string };

/** What a notification needs to know about a charge the insert created. */
const INSERTED_COLS = 'id, kind, status, posted_at, merchant, merchant_raw, amount, currency, account_id, scope, cat';

/**
 * Postgres codes that mean "this row, as written, will never go in": a check,
 * a missing or malformed value, a reference to nothing. Retrying the run
 * cannot fix those, so the row is set aside and the rest are saved. Anything
 * else — a timeout, an outage — still fails the run, so it is retried whole.
 */
const ROW_REJECTED = new Set(['23514', '23502', '23503', '22P02', '22003', '22001', '22007', '22008']);
const rowRejected = (e: { code?: string } | null) => !!e?.code && ROW_REJECTED.has(e.code);

/** Long enough for a few pushes; short enough that a stuck one never stalls the sync. */
const NOTIFY_BUDGET_MS = 15_000;

/**
 * Announce newly inserted charges. Never throws, and never takes longer than
 * NOTIFY_BUDGET_MS: the charges are saved whatever happens here, and a failed
 * import would only make the sync send the same emails again.
 */
// deno-lint-ignore no-explicit-any
async function notify(db: any, userId: string, inserted: any[], accounts: any[]) {
  try {
    const alerts = chargeAlerts(inserted, accounts, new Date());
    if (!alerts.length) return { alerts: 0 };
    const problem = vapidProblem();
    if (problem) return { alerts: alerts.length, skipped: problem };

    // A charge alert is worth a few hours to a phone that is offline, not a
    // day; and it is sent at high urgency, as a bank's own alert would be.
    const send = createSender({ ttlSeconds: 6 * 3600, urgency: 'high' });
    const run = sendChargeAlerts({
      async listSubscriptions(uid: string) {
        const { data, error } = await db.from('push_subscriptions')
          .select('endpoint, p256dh, auth').eq('user_id', uid).eq('notify_charges', true);
        if (error) throw new Error(`subscriptions: ${error.message}`);
        return data ?? [];
      },
      send,
      async removeSubscription(endpoint: string) {
        await db.from('push_subscriptions').delete().eq('endpoint', endpoint);
      },
    }, userId, alerts);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ alerts: alerts.length, errors: ['timed out'] }), NOTIFY_BUDGET_MS);
    });
    const report = await Promise.race([run, late]);
    clearTimeout(timer);
    console.log('[notify]', JSON.stringify(report));
    return report;
  } catch (err) {
    console.error('[notify]', (err as Error).message);
    return { error: (err as Error).message };
  }
}

/**
 * What a run is for.
 *
 *   import  — the normal path: write charges that are not in the table yet.
 *   repair-dates — correct `posted_at` on charges that ARE in the table, from
 *                  the email that brought them in. Nothing else is touched.
 *
 * The repair exists because the app's edit sheet once took a charge's date by
 * slicing the UTC timestamp and wrote it back as noon, so every charge that
 * was reviewed by hand lost the minute the bank recorded — and, for anything
 * after 6pm Costa Rica, gained a day. The emails still hold the truth, and
 * the parser already reads it correctly; the only reason an ordinary re-sync
 * cannot fix this is `ignoreDuplicates`, which is there to protect exactly
 * the hand edits that must be kept.
 *
 * So this updates one column and no other, matched on ext_id. A category, a
 * renamed merchant, a reimbursement, an account correction: all untouched.
 */
type Mode = 'import' | 'repair-dates';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!secretOk(req.headers.get('x-ingest-secret') ?? '')) {
    return json({ error: 'unauthorized' }, 401);
  }

  let payload: { messages?: Incoming[]; mode?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const messages = payload.messages ?? [];
  if (!Array.isArray(messages)) return json({ error: 'messages must be an array' }, 400);
  if (messages.length > 200) return json({ error: 'too many messages; send ≤200' }, 413);

  const mode: Mode = payload.mode === 'repair-dates' ? 'repair-dates' : 'import';

  const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Single-user app. Rather than trusting the caller to name a user, derive it
  // from the data: if more than one ever exists, stop instead of guessing.
  const { data: owners, error: ownerErr } = await db
    .from('accounts').select('user_id').limit(1000);
  if (ownerErr) return json({ error: `accounts: ${ownerErr.message}` }, 500);

  const userIds = [...new Set((owners ?? []).map((r: { user_id: string }) => r.user_id))];
  if (userIds.length !== 1) {
    return json({ error: `expected exactly one user, found ${userIds.length}` }, 500);
  }
  const userId = userIds[0];

  const [{ data: accounts, error: accErr }, { data: rawRules, error: ruleErr }] =
    await Promise.all([
      db.from('accounts')
        .select('id, label, issuer, last4, default_currency, scope, active')
        .eq('user_id', userId).eq('active', true),
      db.from('rules')
        .select('id, pattern, match_type, priority, cat, budget_line_id, scope, merchant_clean')
        .eq('user_id', userId).order('priority'),
    ]);
  if (accErr) return json({ error: `accounts: ${accErr.message}` }, 500);
  if (ruleErr) return json({ error: `rules: ${ruleErr.message}` }, 500);

  type RuleRow = {
    id: string; pattern: string; match_type: string; priority: number;
    cat: string | null; budget_line_id: string | null;
    scope: string | null; merchant_clean: string | null;
  };
  const rules = (rawRules ?? []).map((r: RuleRow) => ({
    id: r.id, pattern: r.pattern, matchType: r.match_type, priority: r.priority,
    cat: r.cat, budgetLineId: r.budget_line_id, scope: r.scope, merchantClean: r.merchant_clean,
  }));

  const rows: Record<string, unknown>[] = [];
  // The message each row came from, to say which one when a row is refused.
  const rowIds: (string | undefined)[] = [];
  const skipped: Record<string, unknown>[] = [];

  for (const m of messages) {
    const parsed = parseEmail({
      from: m.from, subject: m.subject ?? '', body: m.body ?? '', html: m.html ?? '',
    });
    if (!parsed.ok) {
      // 'ignored' and 'unknown-sender' are routine — the mailbox holds plenty
      // that is not a charge. A parse-error is not routine and is reported.
      skipped.push({
        id: m.id, reason: parsed.reason, detail: parsed.detail,
        // Only a parse failure needs evidence; an ignored sender does not.
        ...(parsed.reason === 'parse-error'
          ? { issuer: parsed.issuer, sample: parsed.sample, tried: parsed.tried }
          : {}),
      });
      continue;
    }

    const r = parsed.record;
    rowIds.push(m.id);
    rows.push(toTransactionRow({
      record: r,
      hit: matchRule(rules, r.merchantRaw, r.mcc),
      account: findAccount(accounts, r),
      userId,
    }));
  }

  if (mode === 'repair-dates') {
    // The decision lives in _shared/repair.js so it is covered by the same
    // node tests as the parsers, rather than only by a deploy.
    let result;
    try {
      result = await repairPostedAt(db, userId, rows);
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }

    return json({
      ok: true, mode,
      received: messages.length,
      parsed: rows.length,
      repaired: result.changed.length,
      alreadyCorrect: result.alreadyCorrect,
      changed: result.changed,
      skipped,
    });
  }

  let imported = 0;
  let rejected = 0;
  // deno-lint-ignore no-explicit-any
  let inserted: any[] = [];
  if (rows.length) {
    // ignoreDuplicates, NOT a plain upsert. A charge already in the table may
    // have been recategorized or renamed by hand since it arrived; re-running
    // the sync must never overwrite that with the raw email again.
    const write = (batch: Record<string, unknown>[]) => db
      .from('transactions')
      .upsert(batch, { onConflict: 'user_id,ext_id', ignoreDuplicates: true })
      // Only the rows actually inserted come back; duplicates do not.
      .select(INSERTED_COLS);

    const all = await write(rows);
    if (!all.error) {
      inserted = all.data ?? [];
    } else if (!rowRejected(all.error)) {
      return json({ error: `insert: ${all.error.message}` }, 500);
    } else {
      // One row the database will not take must not hold back the rest. A
      // single ₡0 card check once stopped every sync for hours, because the
      // whole batch was refused and the same batch was offered again each
      // time. Written one at a time, the good ones go in and the bad one is
      // reported — and the run succeeds, so the sync moves past it.
      for (let i = 0; i < rows.length; i++) {
        const one = await write([rows[i]]);
        if (!one.error) {
          inserted.push(...(one.data ?? []));
          continue;
        }
        if (!rowRejected(one.error)) return json({ error: `insert: ${one.error.message}` }, 500);
        rejected += 1;
        const row = rows[i];
        const entry = {
          id: rowIds[i], reason: 'rejected', detail: one.error.message,
          issuer: String(row.ext_id ?? '').split(':')[0] || null,
          sample: `${row.merchant_raw ?? '?'} · ${row.currency} ${row.amount} · ${row.posted_at}`,
        };
        skipped.push(entry);
        console.warn('[insert] row refused:', JSON.stringify(entry));
      }
    }
    imported = inserted.length;
  }

  const notified = await notify(db, userId, inserted, accounts ?? []);

  return json({
    ok: true,
    mode,
    received: messages.length,
    imported,
    duplicates: rows.length - imported - rejected,
    rejected,
    skipped,
    unmatchedAccount: rows.filter((r) => r.account_id === null).length,
    notified,
  });
});
