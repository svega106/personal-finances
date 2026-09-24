/**
 * Reloading server data without reloading the page.
 *
 * Four caches hold data that came from the server, each owned by the module
 * that reads it:
 *
 *   state.js          the budget, goals and settings for every month
 *   tx.js             the ledger, per month
 *   views-accounts.js account balances
 *   work.js           outstanding work charges
 *
 * They are separate for good reasons — a budget is one blob written whole, a
 * ledger is rows written one at a time — but it left every write site
 * responsible for knowing which of the four its own change had invalidated.
 * Saving a transaction dropped the ledger and nothing else, so a new charge
 * did not move the card balance on the Accounts view, and the only way to
 * correct that was a full page reload, which lands you back on the dashboard.
 *
 * So writes no longer invalidate caches themselves. They say what kind of
 * change happened, and this module decides what that invalidates.
 */
import { flush, init } from './state.js';
import { loadMonth, loadReference } from './tx.js';
import { invalidateWork, loadWork } from './work.js';
import { invalidateAccounts } from './views-accounts.js';
import { updateNavBadge } from './views-tx.js';
import { render, getCurrentMonth } from './app.js';

/**
 * A transaction was added, changed or deleted.
 *
 * `month` is the month the charge is dated in, which is not always the month
 * on screen: re-dating a charge into August while looking at September has to
 * reload both, or the one you are looking at keeps a row that left it.
 */
export async function afterLedgerChange(month) {
  const viewing = getCurrentMonth();
  const months = month && month !== viewing ? [viewing, month] : [viewing];

  // Balances and work charges are both derived from the ledger, so both are
  // now wrong whatever the change was.
  invalidateAccounts();
  invalidateWork();

  const [current] = await Promise.all(months.map((k) => loadMonth(k, { force: true })));
  updateNavBadge(current);
  render();
}

/**
 * An account was added, renamed, re-carded or archived.
 *
 * The account list is read once at boot, so it has to be re-read. Work
 * charges go with it: whether a charge is the company's or out of pocket is
 * decided by the scope of the card it is on, not by anything stored on the
 * charge, so moving a card between scopes reclassifies its history.
 */
export async function afterAccountChange() {
  await loadReference();
  invalidateAccounts();
  invalidateWork();
  render();
}

/**
 * Re-read everything from the server, for the refresh button.
 *
 * Pending budget edits are flushed first. `init()` replaces local state with
 * whatever the server holds, so a debounced save still inside its 700ms
 * window would be thrown away — refreshing must never be able to lose an
 * amount that was just typed.
 */
export async function refreshAll() {
  await flush();

  const month = getCurrentMonth();
  invalidateAccounts();
  invalidateWork();

  const [, , rows] = await Promise.all([
    init(),
    loadReference(),
    loadMonth(month, { force: true }),
    loadWork({ force: true }),
  ]);

  updateNavBadge(rows);
  render();
}
