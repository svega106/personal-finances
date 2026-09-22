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

    /** Test helper: what the repo currently holds. */
    _dump() {
      return structuredClone(store);
    },
  };
}
