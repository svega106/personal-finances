/**
 * Work charges and getting the money back.
 *
 * Deliberately not scoped to the month on screen. A September charge is
 * usually reimbursed in October, so a month-bound list would mean navigating
 * backwards to settle something you were just paid for. Outstanding is
 * outstanding, whenever it happened.
 */
import { getRepo } from './repo.js';

/** Far enough back to cover a slow reimbursement, short enough to stay small. */
const WINDOW_MONTHS = 18;

let charges = null;
let loading = false;

export function windowStart(now = new Date()) {
  const d = new Date(now);
  d.setMonth(d.getMonth() - WINDOW_MONTHS);
  return `${d.toISOString().slice(0, 7)}-01T00:00:00-06:00`;
}

/** A charge counts as settled only when it says so. */
export function isReimbursed(t) {
  return t.reimbursement?.status === 'reimbursed';
}

export function splitWork(rows) {
  const outstanding = [];
  const settled = [];
  for (const t of rows ?? []) {
    if (t.status === 'voided') continue;
    (isReimbursed(t) ? settled : outstanding).push(t);
  }
  return { outstanding, settled };
}

/** Totals per currency — work charges are never converted into one figure. */
export function totalByCurrency(rows) {
  const out = {};
  for (const t of rows ?? []) out[t.currency] = (out[t.currency] || 0) + t.amount;
  return out;
}

export function cachedWork() { return charges; }

export function invalidateWork() { charges = null; }

export async function loadWork({ force = false } = {}) {
  if (charges && !force) return charges;
  charges = await getRepo().listWorkCharges({ since: windowStart() });
  return charges;
}

/**
 * For views that render synchronously: hands back what is cached and loads in
 * the background on a miss, re-rendering once the rows arrive.
 */
export function workFor(onLoaded) {
  if (charges) return { rows: charges, loading: false };
  if (!loading) {
    loading = true;
    loadWork().then(() => { loading = false; onLoaded?.(); })
      .catch(() => { loading = false; });
  }
  return { rows: [], loading: true };
}

/** Settling is just a date. Undo removes the record rather than flagging it. */
export function settle(t, on) {
  return { ...t, reimbursement: { status: 'reimbursed', on } };
}

export function unsettle(t) {
  return { ...t, reimbursement: { status: 'pending' } };
}
