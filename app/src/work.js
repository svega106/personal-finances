/**
 * Work charges and getting the money back.
 *
 * Deliberately not scoped to the month on screen. A September charge is
 * usually reimbursed in October, so a month-bound list would mean navigating
 * backwards to settle something you were just paid for. Outstanding is
 * outstanding, whenever it happened.
 */
import { getRepo } from './repo.js';
import { accountById } from './tx.js';
import { crMonth, CR_OFFSET } from './cr-date.js';

/** Far enough back to cover a slow reimbursement, short enough to stay small. */
const WINDOW_MONTHS = 18;

let charges = null;
let loading = false;

export function windowStart(now = new Date()) {
  const d = new Date(now);
  d.setMonth(d.getMonth() - WINDOW_MONTHS);
  return `${crMonth(d)}-01T00:00:00${CR_OFFSET}`;
}

/** A charge counts as settled only when it says so. */
export function isReimbursed(t) {
  return t.reimbursement?.status === 'reimbursed';
}

/**
 * Whether the company paid for this directly.
 *
 * Derived from the card, not stored on the charge. The BNCR card is the
 * company's: money spent on it never leaves Sebas's pocket, so there is
 * nothing to claim back. A work expense put on a personal card is the
 * opposite — his money, until it comes back.
 *
 * Deriving it means moving a charge to a different card corrects it, and a
 * row written before this distinction existed is read correctly rather than
 * needing its stored status to be right.
 *
 * An unknown card counts as out of pocket: that is the state that gets
 * chased, and something needing attention it does not deserve is a better
 * failure than money quietly written off.
 */
export function isCompanyPaid(t) {
  return accountById(t.accountId)?.scope === 'work';
}

/**
 * Three groups, not two.
 *
 *   owed        — your money, not back yet. The only one worth chasing.
 *   settled     — your money, since returned.
 *   companyPaid — never your money. Recorded, never chased.
 */
export function splitWork(rows) {
  const owed = [];
  const settled = [];
  const companyPaid = [];

  for (const t of rows ?? []) {
    if (t.status === 'voided') continue;
    if (isCompanyPaid(t)) companyPaid.push(t);
    else if (isReimbursed(t)) settled.push(t);
    else owed.push(t);
  }
  return { owed, settled, companyPaid };
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

/**
 * What a work charge's reimbursement field should say, given the card it is
 * on. Used by the ingest and by the edit sheet, so both agree.
 */
export function initialReimbursement(account) {
  // Nothing to claim back on the company's own card.
  return account?.scope === 'work' ? null : { status: 'pending' };
}

/** Settling is just a date. Undo removes the record rather than flagging it. */
export function settle(t, on) {
  return { ...t, reimbursement: { status: 'reimbursed', on } };
}

export function unsettle(t) {
  return { ...t, reimbursement: { status: 'pending' } };
}
