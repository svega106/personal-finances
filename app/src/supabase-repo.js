import { createClient } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configured = Boolean(URL && ANON);

/**
 * The anon key is public by design — row-level security is what protects the
 * data, not secrecy of this key. The service-role key must never appear here.
 */
export const supabase = configured
  ? createClient(URL, ANON, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

/** Surface the real Postgres message rather than a bare "failed". */
function boom(what, error) {
  const e = new Error(`${what}: ${error.message || error}`);
  e.cause = error;
  throw e;
}

async function userId() {
  const { data, error } = await supabase.auth.getUser();
  if (error) boom('auth.getUser', error);
  if (!data?.user) throw new Error('Not signed in');
  return data.user.id;
}

/**
 * The monthly plan lives in `budgets.data` as jsonb, matching the shape the
 * compute engine already expects. Goals and settings are ordinary rows.
 */
export function createSupabaseRepo() {
  return extendWithTransactions({
    async loadAll() {
      const uid = await userId();

      const [budgets, goals, settings] = await Promise.all([
        supabase.from('budgets').select('month, data').eq('user_id', uid),
        supabase
          .from('goals')
          .select('id, name, target, saved, monthly, deadline, account_id, sort_order')
          .eq('user_id', uid)
          .order('sort_order'),
        supabase.from('settings').select('data').eq('user_id', uid).maybeSingle(),
      ]);

      if (budgets.error) boom('load budgets', budgets.error);
      if (goals.error) boom('load goals', goals.error);
      if (settings.error) boom('load settings', settings.error);

      const months = {};
      for (const row of budgets.data ?? []) months[row.month] = row.data;

      return {
        months,
        // Numerics arrive as strings from PostgREST; the compute engine does
        // arithmetic on these, so coerce here rather than at every use.
        goals: (goals.data ?? []).map((g) => ({
          id: g.id,
          name: g.name,
          target: Number(g.target) || 0,
          saved: Number(g.saved) || 0,
          monthly: g.monthly == null ? '' : Number(g.monthly),
          deadline: g.deadline ?? '',
          accountId: g.account_id ?? null,
        })),
        settings: settings.data?.data ?? null,
      };
    },

    async saveBudget(month, data) {
      const uid = await userId();
      const { error } = await supabase
        .from('budgets')
        .upsert({ user_id: uid, month, data }, { onConflict: 'user_id,month' });
      if (error) boom(`save ${month}`, error);
    },

    async deleteBudget(month) {
      const uid = await userId();
      const { error } = await supabase
        .from('budgets').delete().eq('user_id', uid).eq('month', month);
      if (error) boom(`delete ${month}`, error);
    },

    /**
     * Goals are few and reorderable, so the whole set is reconciled at once:
     * upsert what is present, delete what is gone.
     */
    async saveGoals(goals) {
      const uid = await userId();

      const rows = goals.map((g, i) => ({
        id: g.id,
        user_id: uid,
        name: g.name,
        target: g.target || 0,
        saved: g.saved || 0,
        monthly: g.monthly === '' || g.monthly == null ? null : g.monthly,
        deadline: g.deadline || null,
        account_id: g.accountId ?? null,
        sort_order: i,
      }));

      if (rows.length) {
        const { error } = await supabase.from('goals').upsert(rows);
        if (error) boom('save goals', error);
      }

      // Goal ids are text, so each value is quoted for the PostgREST `in` list.
      const keep = rows.map((r) => `"${String(r.id).replace(/"/g, '')}"`);
      const del = supabase.from('goals').delete().eq('user_id', uid);
      const { error } = keep.length
        ? await del.not('id', 'in', `(${keep.join(',')})`)
        : await del;
      if (error) boom('prune goals', error);
    },

    async saveSettings(data) {
      const uid = await userId();
      const { error } = await supabase
        .from('settings')
        .upsert({ user_id: uid, data }, { onConflict: 'user_id' });
      if (error) boom('save settings', error);
    },
  });
}

/* ----------------------------------------------------------- transactions */

const TX_COLS =
  'id, ext_id, kind, posted_at, merchant_raw, merchant, amount, currency, amount_crc,' +
  ' fx_rate, account_id, counterparty_account_id, scope, reimbursement, cat,' +
  ' budget_line_id, source, method, status, reviewed, auth_code, reference, mcc, note';

/** DB row -> the camelCase shape the app works in. */
function txFromRow(r) {
  return {
    id: r.id,
    extId: r.ext_id,
    kind: r.kind,
    postedAt: r.posted_at,
    merchantRaw: r.merchant_raw,
    merchant: r.merchant,
    amount: Number(r.amount) || 0,
    currency: r.currency,
    amountCrc: Number(r.amount_crc) || 0,
    fxRate: r.fx_rate == null ? null : Number(r.fx_rate),
    accountId: r.account_id,
    counterpartyAccountId: r.counterparty_account_id,
    scope: r.scope,
    reimbursement: r.reimbursement,
    cat: r.cat,
    budgetLineId: r.budget_line_id,
    source: r.source,
    method: r.method,
    status: r.status,
    reviewed: r.reviewed,
    authCode: r.auth_code,
    reference: r.reference,
    mcc: r.mcc,
    note: r.note,
  };
}

function txToRow(t, uid) {
  const row = {
    user_id: uid,
    ext_id: t.extId,
    kind: t.kind || 'expense',
    posted_at: t.postedAt,
    merchant_raw: t.merchantRaw ?? null,
    merchant: t.merchant ?? null,
    amount: t.amount,
    currency: t.currency || 'CRC',
    // A foreign charge stores only its own currency; its colón value comes
    // from the month's rate, held in fx_rates.
    amount_crc: t.currency === 'CRC' ? t.amount : null,
    fx_rate: null,
    account_id: t.accountId ?? null,
    counterparty_account_id: t.counterpartyAccountId ?? null,
    scope: t.scope || 'personal',
    reimbursement: t.reimbursement ?? null,
    cat: t.cat ?? null,
    budget_line_id: t.budgetLineId ?? null,
    source: t.source || 'manual',
    method: t.method || 'card',
    status: t.status || 'pending',
    reviewed: !!t.reviewed,
    auth_code: t.authCode ?? null,
    reference: t.reference ?? null,
    mcc: t.mcc ?? null,
    note: t.note ?? null,
  };
  if (t.id) row.id = t.id;
  return row;
}

export function extendWithTransactions(repo) {
  return Object.assign(repo, {
    async listAccounts() {
      const uid = await userId();
      const { data, error } = await supabase
        .from('accounts')
        .select('id, label, type, issuer, institution, brand, last4, default_currency, scope, active, sort_order')
        .eq('user_id', uid).eq('active', true).order('sort_order');
      if (error) boom('load accounts', error);
      return (data ?? []).map((a) => ({
        id: a.id, label: a.label, type: a.type, issuer: a.issuer,
        institution: a.institution, brand: a.brand, last4: a.last4,
        currency: a.default_currency, scope: a.scope,
      }));
    },

    async listRules() {
      const uid = await userId();
      const { data, error } = await supabase
        .from('rules')
        .select('id, pattern, match_type, priority, cat, budget_line_id, scope, merchant_clean')
        .eq('user_id', uid).order('priority');
      if (error) boom('load rules', error);
      return (data ?? []).map((r) => ({
        id: r.id, pattern: r.pattern, matchType: r.match_type, priority: r.priority,
        cat: r.cat, budgetLineId: r.budget_line_id, scope: r.scope, merchantClean: r.merchant_clean,
      }));
    },

    async listFxRates() {
      const uid = await userId();
      const { data, error } = await supabase
        .from('fx_rates').select('month, currency, rate').eq('user_id', uid);
      if (error) boom('load fx rates', error);
      return (data ?? []).map((r) => ({
        month: r.month, currency: r.currency, rate: Number(r.rate),
      }));
    },

    async saveFxRate({ month, currency, rate }) {
      const uid = await userId();
      const { error } = await supabase
        .from('fx_rates')
        .upsert({ user_id: uid, month, currency, rate },
                { onConflict: 'user_id,month,currency' });
      if (error) boom('save fx rate', error);
    },

    async listTransactions({ from, to }) {
      const uid = await userId();
      const { data, error } = await supabase
        .from('transactions').select(TX_COLS)
        .eq('user_id', uid)
        .gte('posted_at', from).lt('posted_at', to)
        .order('posted_at', { ascending: false });
      if (error) boom('load transactions', error);
      return (data ?? []).map(txFromRow);
    },

    async upsertTransaction(t) {
      const uid = await userId();
      const { data, error } = await supabase
        .from('transactions')
        .upsert(txToRow(t, uid), { onConflict: 'user_id,ext_id' })
        .select(TX_COLS).single();
      if (error) boom('save transaction', error);
      return txFromRow(data);
    },

    async deleteTransaction(id) {
      const uid = await userId();
      const { error } = await supabase
        .from('transactions').delete().eq('user_id', uid).eq('id', id);
      if (error) boom('delete transaction', error);
    },
  });
}
