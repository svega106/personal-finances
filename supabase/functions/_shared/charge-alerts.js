/**
 * A notification for each new card charge, as the sync brings it in.
 *
 * The ingest function passes in the rows its insert actually created. A
 * re-sent email is a duplicate and is never inserted, so a charge is only
 * ever announced once, however many times the sync sees its email.
 *
 * Everything that decides anything is here, with the database and the push
 * service passed in, so it is under the node tests; the function is wiring.
 *
 * Rows are in the database's shape (snake_case), because that is what the
 * insert hands back.
 */
import { sendToDevices } from './push-delivery.js';

/**
 * A charge older than this is history being re-imported — a resync after a
 * parser fix brings back a month of mail — not a purchase just made.
 */
export const FRESH_HOURS = 24;

/** Up to this many at once, one notification each. More arrive as a summary. */
export const MAX_SINGLE = 3;

const CAT_LABEL = { needs: 'Essentials', wants: 'Discretionary', savings: 'Savings' };

/** ₡38,500 and $4.99, as the app writes them. */
export function formatAmount(amount, currency) {
  const n = Number(amount) || 0;
  if (currency === 'CRC') return `₡${Math.round(n).toLocaleString('en-US')}`;
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'USD' ? `$${s}` : `${currency} ${s}`;
}

const nameOf = (row) => row.merchant || row.merchant_raw || 'Unknown merchant';

/** New purchases made recently, oldest first, so the newest ends on top. */
export function freshCharges(rows, now) {
  const since = now.getTime() - FRESH_HOURS * 3600e3;
  return (rows ?? [])
    .filter((r) => r.kind === 'expense' && r.status !== 'voided' && Date.parse(r.posted_at) >= since)
    .sort((a, b) => Date.parse(a.posted_at) - Date.parse(b.posted_at));
}

/** Which card it was on, the way the app names it. */
function cardOf(account) {
  if (!account) return 'A card the app does not know yet';
  const label = account.label || 'Card';
  return account.last4 && !label.includes(account.last4) ? `${label} ••${account.last4}` : label;
}

/**
 * What happens to it next. The company pays its own card; a work charge on
 * a personal card is waiting to be paid back; anything else counts against
 * the budget under its category, or is waiting for one.
 */
function fateOf(row, account) {
  if (account?.scope === 'work') return 'Paid by the company';
  if (row.scope === 'work') return 'Work — to be reimbursed';
  return CAT_LABEL[row.cat] ?? 'Tap to categorize';
}

export function alertFor(row, account) {
  return {
    kind: 'charge',
    title: `${formatAmount(row.amount, row.currency)} at ${nameOf(row)}`,
    body: `${cardOf(account)} · ${fateOf(row, account)}`,
    // Per charge: a second copy of the same one replaces the first.
    tag: `charge:${row.id}`,
    // Opens the charge itself, ready to categorize.
    url: `/?view=transactions&tx=${encodeURIComponent(row.id)}`,
  };
}

export function summaryFor(rows) {
  const listed = rows.slice(-MAX_SINGLE).reverse()
    .map((r) => `${nameOf(r)} ${formatAmount(r.amount, r.currency)}`);
  const more = rows.length - listed.length;
  return {
    kind: 'charge',
    title: `${rows.length} new charges`,
    body: listed.join(' · ') + (more ? ` · and ${more} more` : ''),
    tag: `charges:${rows[rows.length - 1].id}`,
    url: '/?view=transactions',
  };
}

/**
 * The notifications for one sync's new rows: one each when there are a few,
 * a single summary when a batch arrives at once, nothing for old charges.
 */
export function chargeAlerts(rows, accounts, now) {
  const fresh = freshCharges(rows, now);
  if (!fresh.length) return [];
  if (fresh.length > MAX_SINGLE) return [summaryFor(fresh)];
  const byId = new Map((accounts ?? []).map((a) => [a.id, a]));
  return fresh.map((r) => alertFor(r, byId.get(r.account_id)));
}

/**
 * Send them to every device that has new-charge notifications on.
 *
 * Never throws. The charge is already saved when this runs; a notification
 * that could not go out must not turn a good import into a failed one, which
 * would only make the sync send the same email again.
 *
 * @param {object} deps
 *   listSubscriptions(userId, kind)  devices with `kind` ('charges') switched on
 *   send(device, payload)            { ok } or { ok: false, gone, error }
 *   removeSubscription(endpoint)
 */
export async function sendChargeAlerts(deps, userId, alerts) {
  const report = { alerts: alerts.length, devices: 0, delivered: 0, removedDevices: 0, errors: [] };
  if (!alerts.length) return report;
  try {
    let devices = await deps.listSubscriptions(userId, 'charges');
    report.devices = devices.length;
    for (const payload of alerts) {
      if (!devices.length) break;
      const r = await sendToDevices(deps, devices, payload);
      report.delivered += r.delivered;
      report.removedDevices += r.gone.length;
      report.errors.push(...r.errors);
      // A device found gone on the first alert is not tried for the rest.
      devices = devices.filter((d) => !r.gone.includes(d.endpoint));
    }
  } catch (err) {
    report.errors.push(err.message);
  }
  return report;
}
