/**
 * When to reload, decided without a page: the once-a-minute check, a
 * notification arriving, coming back to the app, and waiting while someone
 * is mid-edit. live.js wires it to the document; this part is under test.
 */

/** How often an open, visible app asks whether the ledger changed. */
export const POLL_MS = 60_000;
/** Away at least this long, and coming back reloads everything, not only the ledger. */
export const RESUME_AFTER_MS = 2 * 60_000;

/**
 * @param {object} deps
 *   marker()         a string that changes whenever the ledger does
 *   refreshLedger()  reload the ledger and what is derived from it
 *   refreshAll()     reload everything
 *   busy()           true while reloading would disturb someone mid-edit
 *   now()            milliseconds
 */
export function createLive({ marker, refreshLedger, refreshAll: reloadAll, busy = () => false, now = Date.now }) {
  let baseline = null;   // the marker the screen is known to reflect
  let reads = 0;         // numbers each marker read, so a late answer never wins
  let adopted = 0;
  let running = false;
  let pending = null;    // 'ledger' | 'all', waiting for a sheet to close
  let hiddenAt = null;

  const bigger = (a, b) => (a === 'all' || b === 'all' ? 'all' : a || b);

  /**
   * Take the ledger as it is right now as what the screen shows. Called as
   * every reload starts: anything written after this read changes the marker
   * again, so the next check still catches it.
   */
  async function adopt() {
    const n = ++reads;
    try {
      const m = await marker();
      if (n > adopted) { adopted = n; baseline = m; }
    } catch { /* the next check reads it again */ }
  }

  async function run(kind) {
    if (running || busy()) {
      pending = bigger(pending, kind);
      return false;
    }
    running = true;
    try {
      await (kind === 'all' ? reloadAll() : refreshLedger());
    } catch (err) {
      console.warn('[live]', err?.message ?? err);
    } finally {
      running = false;
    }
    if (pending && !busy()) {
      const next = pending;
      pending = null;
      await run(next);
    }
    return true;
  }

  return {
    adopt,

    /** A refresh is waiting for a sheet to close. */
    get pending() { return pending; },

    /** The minute check: reload only if the ledger moved. */
    async tick() {
      if (pending) {
        if (busy()) return false;
        const kind = pending;
        pending = null;
        return run(kind);
      }
      const n = ++reads;
      let m;
      try { m = await marker(); } catch { return false; }
      if (baseline === null) {
        if (n > adopted) { adopted = n; baseline = m; }
        return false;
      }
      if (m === baseline) return false;
      return run('ledger');
    },

    /** A new-charge notification reached this device. */
    pushed() { return run('ledger'); },

    hidden() { hiddenAt = now(); },

    /** Back on screen: everything after a real absence, a check otherwise. */
    visible() {
      const away = hiddenAt === null ? 0 : now() - hiddenAt;
      hiddenAt = null;
      return away >= RESUME_AFTER_MS ? run('all') : this.tick();
    },
  };
}
