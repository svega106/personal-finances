/**
 * In-memory repository. Used by the smoke test, and by `npm run dev` when no
 * Supabase credentials are configured, so the app is runnable before anyone
 * has set up a project.
 *
 * Writes go nowhere. That is the point: nothing here should be mistaken for
 * persistence.
 */
export function createMemoryRepo(seed = {}) {
  const store = {
    months: structuredClone(seed.months ?? {}),
    goals: structuredClone(seed.goals ?? []),
    settings: structuredClone(seed.settings ?? null),
    accounts: structuredClone(seed.accounts ?? []),
    fxRates: structuredClone(seed.fxRates ?? []),
    rules: structuredClone(seed.rules ?? []),
    transactions: structuredClone(seed.transactions ?? []),
    snapshots: structuredClone(seed.snapshots ?? []),
  };

  let seq = 1;

  return {
    async loadAll() {
      return structuredClone(store);
    },
    async saveBudget(month, data) {
      store.months[month] = structuredClone(data);
    },
    async deleteBudget(month) {
      delete store.months[month];
    },
    async saveGoals(goals) {
      store.goals = structuredClone(goals);
    },
    async saveSettings(settings) {
      store.settings = structuredClone(settings);
    },
    async listAccounts() { return structuredClone(store.accounts); },
    async listRules() { return structuredClone(store.rules); },
    async listFxRates() { return structuredClone(store.fxRates); },

    async saveFxRate({ month, currency, rate }) {
      const at = store.fxRates.findIndex((x) => x.month === month && x.currency === currency);
      if (at >= 0) store.fxRates[at].rate = rate;
      else store.fxRates.push({ month, currency, rate });
    },

    async listTransactions({ from, to }) {
      return structuredClone(store.transactions)
        .filter((t) => t.postedAt >= from && t.postedAt < to)
        .sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1));
    },

    async listWorkCharges({ since }) {
      return structuredClone(store.transactions)
        .filter((t) => t.scope === 'work' && t.postedAt >= since)
        .sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1));
    },

    async upsertTransaction(t) {
      const row = structuredClone(t);
      // Mirrors the unique (user_id, ext_id) constraint in Postgres.
      const at = store.transactions.findIndex(
        (x) => (row.id && x.id === row.id) || x.extId === row.extId,
      );
      if (at >= 0) {
        row.id = store.transactions[at].id;
        store.transactions[at] = row;
      } else {
        row.id = row.id || `tx${seq++}`;
        store.transactions.push(row);
      }
      return structuredClone(row);
    },

    async deleteTransaction(id) {
      const at = store.transactions.findIndex((x) => x.id === id);
      if (at >= 0) store.transactions.splice(at, 1);
    },

    /* ----------------------------------------------------------- balances */

    async listAccountBalances() {
      // Mirrors the `account_balances` view: last snapshot on or before today,
      // plus every transaction posted after it.
      return store.accounts.map((a) => {
        const snaps = store.snapshots
          .filter((s) => s.accountId === a.id)
          .sort((x, y) => (x.asOf < y.asOf ? 1 : -1));
        const last = snaps[0] ?? null;
        const moved = store.transactions
          .filter((t) => t.status !== 'voided'
            && t.currency === a.currency
            && (t.accountId === a.id || t.counterpartyAccountId === a.id)
            && (!last || String(t.postedAt).slice(0, 10) > last.asOf))
          .reduce((sum, t) => {
            if (t.kind === 'income' || t.kind === 'adjustment') return sum + t.amount;
            if (t.kind === 'transfer') {
              return t.counterpartyAccountId === a.id ? sum + t.amount : sum - t.amount;
            }
            if (t.kind === 'expense') return sum - t.amount;
            return sum;
          }, 0);

        const days = last
          ? (Date.now() - new Date(`${last.asOf}T12:00:00Z`).getTime()) / 86400000
          : null;

        return {
          accountId: a.id,
          label: a.label,
          type: a.type,
          currency: a.currency,
          snapshotDate: last?.asOf ?? null,
          snapshotBalance: last ? last.balance : null,
          currentBalance: (last ? last.balance : 0) + moved,
          hasSnapshot: !!last,
          stale: last ? days > 30 : null,
          scope: a.scope || 'personal',
        };
      });
    },

    async listSnapshots(accountId, limit = 12) {
      return structuredClone(store.snapshots)
        .filter((s) => s.accountId === accountId)
        .sort((a, b) => (a.asOf < b.asOf ? 1 : -1))
        .slice(0, limit);
    },

    async saveSnapshot({ accountId, asOf, balance, currency, note }) {
      const at = store.snapshots.findIndex(
        (s) => s.accountId === accountId && s.asOf === asOf);
      const row = { accountId, asOf, balance, currency, note: note || null };
      if (at >= 0) { row.id = store.snapshots[at].id; store.snapshots[at] = row; }
      else { row.id = `sn${seq++}`; store.snapshots.push(row); }
    },

    async deleteSnapshot(id) {
      const at = store.snapshots.findIndex((s) => s.id === id);
      if (at >= 0) store.snapshots.splice(at, 1);
    },

    async upsertAccount(a) {
      const row = structuredClone(a);
      row.type = row.type || 'savings';
      row.currency = row.currency || 'CRC';
      row.scope = row.scope || 'personal';
      const at = row.id ? store.accounts.findIndex((x) => x.id === row.id) : -1;
      if (at >= 0) store.accounts[at] = row;
      else { row.id = row.id || `ac${seq++}`; store.accounts.push(row); }
      return structuredClone(row);
    },

    async archiveAccount(id) {
      const at = store.accounts.findIndex((x) => x.id === id);
      if (at >= 0) store.accounts.splice(at, 1); // listAccounts returns active only
    },

    /** Test helper: what the repo currently holds. */
    _dump() {
      return structuredClone(store);
    },
  };
}
