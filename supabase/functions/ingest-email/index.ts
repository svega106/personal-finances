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
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { parseEmail } from '../_shared/parsers.js';
import { matchRule } from '../_shared/classify.js';
import { toTransactionRow, findAccount } from '../_shared/to-row.js';

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

type Incoming = { id?: string; from: string; subject?: string; body?: string };

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!secretOk(req.headers.get('x-ingest-secret') ?? '')) {
    return json({ error: 'unauthorized' }, 401);
  }

  let payload: { messages?: Incoming[] };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const messages = payload.messages ?? [];
  if (!Array.isArray(messages)) return json({ error: 'messages must be an array' }, 400);
  if (messages.length > 200) return json({ error: 'too many messages; send ≤200' }, 413);

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
        .select('id, issuer, last4, default_currency, scope, active')
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
  const skipped: Record<string, unknown>[] = [];

  for (const m of messages) {
    const parsed = parseEmail({ from: m.from, subject: m.subject ?? '', body: m.body ?? '' });
    if (!parsed.ok) {
      // 'ignored' and 'unknown-sender' are routine — the mailbox holds plenty
      // that is not a charge. A parse-error is not routine and is reported.
      skipped.push({ id: m.id, reason: parsed.reason, detail: parsed.detail });
      continue;
    }

    const r = parsed.record;
    rows.push(toTransactionRow({
      record: r,
      hit: matchRule(rules, r.merchantRaw, r.mcc),
      account: findAccount(accounts, r),
      userId,
    }));
  }

  let imported = 0;
  if (rows.length) {
    // ignoreDuplicates, NOT a plain upsert. A charge already in the table may
    // have been recategorized or renamed by hand since it arrived; re-running
    // the sync must never overwrite that with the raw email again.
    const { data, error } = await db
      .from('transactions')
      .upsert(rows, { onConflict: 'user_id,ext_id', ignoreDuplicates: true })
      .select('id');
    if (error) return json({ error: `insert: ${error.message}` }, 500);
    imported = (data ?? []).length;
  }

  return json({
    ok: true,
    received: messages.length,
    imported,
    duplicates: rows.length - imported,
    skipped,
    unmatchedAccount: rows.filter((r) => r.account_id === null).length,
  });
});
