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
  return extendWithBalances(extendWithTransactions({
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
  }));
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

    /**
     * Every work charge since `since`, newest first.
     *
     * Not filtered by reimbursement status in SQL: the status lives in a jsonb
     * column and rows that have never been touched hold null there, so the
     * filter would have to cover both "not reimbursed" and "no reimbursement
     * object at all". There are a few hundred of these a year, so the split
     * happens in the view where it is legible.
     */
    async listWorkCharges({ since }) {
      const uid = await userId();
      const { data, error } = await supabase
        .from('transactions').select(TX_COLS)
        .eq('user_id', uid).eq('scope', 'work')
        .gte('posted_at', since)
        .order('posted_at', { ascending: false });
      if (error) boom('load work charges', error);
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


/* -------------------------------------------------------------- balances */

/**
 * `account_balances` is a view: last manual snapshot, plus every transaction
 * recorded since it. Savings balances are entered by hand because no bank
 * emails a notification when one changes.
 */
function balanceFromRow(r) {
  return {
    accountId: r.account_id,
    label: r.label,
    type: r.type,
    currency: r.currency,
    snapshotDate: r.snapshot_date,
    snapshotBalance: r.snapshot_balance == null ? null : Number(r.snapshot_balance),
    currentBalance: Number(r.current_balance) || 0,
    hasSnapshot: !!r.has_snapshot,
    // null means "never snapshotted" — unknown, not fresh.
    stale: r.snapshot_stale,
    scope: r.scope,
    pendingFx: Number(r.pending_fx) || 0,
  };
}

export function extendWithBalances(repo) {
  return Object.assign(repo, {
    async listAccountBalances() {
      const uid = await userId();
      const { data, error } = await supabase
        .from('account_balances')
        .select('account_id, label, type, currency, snapshot_date, snapshot_balance,'
              + ' current_balance, has_snapshot, snapshot_stale, scope, pending_fx')
        .eq('user_id', uid);
      if (error) boom('load balances', error);
      return (data ?? []).map(balanceFromRow);
    },

    async listSnapshots(accountId, limit = 12) {
      const uid = await userId();
      const { data, error } = await supabase
        .from('balance_snapshots')
        .select('id, account_id, as_of, balance, currency, note')
        .eq('user_id', uid).eq('account_id', accountId)
        .order('as_of', { ascending: false }).limit(limit);
      if (error) boom('load snapshots', error);
      return (data ?? []).map((r) => ({
        id: r.id, accountId: r.account_id, asOf: r.as_of,
        balance: Number(r.balance) || 0, currency: r.currency, note: r.note,
      }));
    },

    /** One snapshot per account per day — re-stating today's balance corrects it. */
    async saveSnapshot({ accountId, asOf, balance, currency, note }) {
      const uid = await userId();
      const { error } = await supabase
        .from('balance_snapshots')
        .upsert({ user_id: uid, account_id: accountId, as_of: asOf,
                  balance, currency, note: note || null },
                { onConflict: 'user_id,account_id,as_of' });
      if (error) boom('save balance', error);
    },

    async deleteSnapshot(id) {
      const uid = await userId();
      const { error } = await supabase
        .from('balance_snapshots').delete().eq('user_id', uid).eq('id', id);
      if (error) boom('delete balance', error);
    },

    async upsertAccount(a) {
      const uid = await userId();
      const row = {
        user_id: uid,
        label: a.label,
        type: a.type || 'savings',
        institution: a.institution ?? null,
        default_currency: a.currency || 'CRC',
        scope: a.scope || 'personal',
        active: a.active === undefined ? true : !!a.active,
        sort_order: a.sortOrder ?? 200,
        // A card is recorded on the account it spends from, so these belong
        // here rather than on an account of their own.
        issuer: a.issuer || null,
        brand: a.brand || null,
        last4: a.last4 || null,
      };
      if (a.id) row.id = a.id;
      const { data, error } = await supabase
        .from('accounts').upsert(row)
        .select('id, label, type, issuer, institution, brand, last4, default_currency, scope, active, sort_order')
        .single();
      if (error) {
        // The unique index is on (user_id, issuer, last4, currency). Saying so
        // is more use than the constraint name.
        if (error.code === '23505') {
          throw new Error(`Another account already has card ····${a.last4} in ${a.currency || 'CRC'}`);
        }
        boom('save account', error);
      }
      return {
        id: data.id, label: data.label, type: data.type, issuer: data.issuer,
        institution: data.institution, brand: data.brand, last4: data.last4,
        currency: data.default_currency, scope: data.scope,
      };
    },

    /**
     * Accounts are archived, never deleted: transactions and snapshots point
     * at them, and history should not change because a card was closed.
     */
    async countTransactions(accountId) {
      const uid = await userId();
      const { count, error } = await supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', uid)
        .or(`account_id.eq.${accountId},counterparty_account_id.eq.${accountId}`);
      if (error) boom('count transactions', error);
      return count ?? 0;
    },

    async archiveAccount(id) {
      const uid = await userId();
      const { error } = await supabase
        .from('accounts').update({ active: false }).eq('user_id', uid).eq('id', id);
      if (error) boom('archive account', error);
    },
  });
}
