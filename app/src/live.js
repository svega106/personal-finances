/**
 * Keeping the screen current without anyone pressing refresh.
 *
 * Charges arrive from a script the app never hears from directly: the sync
 * runs every 15 minutes and writes straight to the database. Three things
 * make the app look again:
 *
 *   - a new-charge notification reaching this device; the service worker
 *     passes it on to any window that is open
 *   - once a minute while the app is on screen, a one-row question: has the
 *     ledger changed? (how many rows there are, and the newest edit)
 *   - coming back to the app after a while in the background, when anything
 *     may have changed — here, on another device, or in the budget
 *
 * What it never does is pull the screen out from under someone: while a sheet
 * is open or a field has the cursor, a refresh waits until they are done.
 *
 * The decisions are in live-core.js, with no DOM, under test. This is the
 * wiring to the page.
 */
import { getRepo } from './repo.js';
import { afterLedgerChange, refreshAll, onReload } from './refresh.js';
import { createLive, POLL_MS } from './live-core.js';

/** How soon a refresh that had to wait for a sheet tries again. */
const RETRY_MS = 5_000;

/** A sheet is open, or the cursor is in a field on the page. */
function busy() {
  if (document.getElementById('modalBg')?.classList.contains('show')) return true;
  const el = document.activeElement;
  return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !!el.closest('#views');
}

/**
 * Wire it to the page. Does nothing for a repository that cannot answer the
 * marker question, which is how older test harnesses run.
 */
export function startLive() {
  const repo = getRepo();
  if (typeof repo.ledgerMarker !== 'function') return null;

  const live = createLive({
    marker: () => repo.ledgerMarker(),
    refreshLedger: () => afterLedgerChange(),
    refreshAll,
    busy,
  });

  // Every reload, whoever started it, first notes what it is about to load.
  onReload(() => { live.adopt(); });
  live.adopt();

  let retry = null;
  const kick = (p) => p.then(() => {
    clearTimeout(retry);
    if (live.pending) retry = setTimeout(() => kick(live.tick()), RETRY_MS);
  });

  // Only while the app can be seen: a phone in a pocket asks nothing.
  let timer = null;
  const schedule = () => {
    clearInterval(timer);
    timer = document.visibilityState === 'visible' ? setInterval(() => kick(live.tick()), POLL_MS) : null;
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') live.hidden();
    else kick(live.visible());
    schedule();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'ledger-changed') kick(live.pushed());
    });
    // Messages from the worker are held until the page says it is listening.
    navigator.serviceWorker.startMessages?.();
  }

  schedule();
  return live;
}
