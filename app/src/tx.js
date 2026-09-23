/**
 * Transaction data.
 *
 * Deliberately separate from `state.js`. The monthly plan is a small blob
 * loaded whole and written back whole; transactions are rows, loaded per month
 * and written one at a time. Mixing them would drag the whole ledger through
 * the budget save path on every keystroke.
 *
 * Writes here are immediate rather than debounced: adding or categorizing a
 * transaction is a deliberate action, not typing.
 */
import { getRepo } from './repo.js';
import { matchRule as sharedMatchRule } from '../../supabase/functions/_shared/classify.js';

/** month key -> transactions, so switching months back and forth is free. */
const byMonth = new Map();

let accounts = [];
let rules = [];

/** "2026-09:USD" -> CRC per unit. Empty until a statement is paid. */
let fxRates = new Map();

export function getAccounts() { return accounts; }
export function getRules() { return rules; }

export function accountById(id) {
  return accounts.find((a) => a.id === id) || null;
}

/** Loaded once at boot; all three lists are small and change rarely. */
export async function loadReference() {
  const repo = getRepo();
  const [a, r, fx] = await Promise.all([
    repo.listAccounts(), repo.listRules(), repo.listFxRates(),
  ]);
  accounts = a;
  rules = r;
  fxRates = new Map(fx.map((x) => [`${x.month}:${x.currency}`, x.rate]));
}

/** CRC per unit of `currency` for that month, or null if not set yet. */
export function rateFor(month, currency) {
  if (currency === 'CRC') return 1;
  return fxRates.get(`${month}:${currency}`) ?? null;
}

export async function setMonthRate(month, currency, rate) {
  await getRepo().saveFxRate({ month, currency, rate });
  fxRates.set(`${month}:${currency}`, rate);
}

/**
 * A charge's colón value, or null when it cannot be known yet.
 *
 * A foreign charge is not converted on the day it happens — the card carries a
 * dollar balance that is settled later, at whatever rate applies then. So its
 * colón value stays unknown until that month's rate is entered, and the app
 * says so rather than inventing a figure.
 */
export function effectiveCrc(t) {
  if (t.currency === 'CRC') return t.amount;
  const rate = rateFor(String(t.postedAt).slice(0, 7), t.currency);
  return rate == null ? null : Math.round(t.amount * rate * 100) / 100;
}

/** Inclusive start, exclusive end — the month's bounds in local time. */
function monthRange(key) {
  const [y, m] = key.split('-').map(Number);
  const from = `${key}-01T00:00:00-06:00`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from, to: `${next}-01T00:00:00-06:00` };
}

export async function loadMonth(key, { force = false } = {}) {
  if (!force && byMonth.has(key)) return byMonth.get(key);
  const { from, to } = monthRange(key);
  const rows = await getRepo().listTransactions({ from, to });
  byMonth.set(key, rows);
  return rows;
}

export function cachedMonth(key) {
  return byMonth.get(key) ?? null;
}

function invalidate(key) { byMonth.delete(key); }

export function monthKeyOf(tx) {
  return String(tx.postedAt).slice(0, 7);
}

/* --------------------------------------------------------------- writing */

export async function saveTransaction(tx) {
  const saved = await getRepo().upsertTransaction(tx);
  invalidate(monthKeyOf(saved));
  return saved;
}

export async function removeTransaction(tx) {
  await getRepo().deleteTransaction(tx.id);
  invalidate(monthKeyOf(tx));
}

/* -------------------------------------------------------- categorization */

/**
 * First matching rule wins, in priority order. Returns the fields a rule
 * contributes, never a whole transaction — the caller decides what to apply.
 */
/**
 * Classifying a charge lives in a shared module, so a merchant lands in the
 * same category whether you entered it here or a bank email brought it in.
 * The shared function is pure, so the module's own `rules` are passed in.
 */
export function matchRule(merchantRaw, mcc) {
  return sharedMatchRule(rules, merchantRaw, mcc);
}

/* --------------------------------------------------------------- totals */

/**
 * Personal spending only. Work-scope charges and transfers never count:
 * a transfer moves money, it does not spend it.
 */
export function spendTotals(rows) {
  // Two distinct figures, easily confused:
  //   uncategorized — no category at all; the review queue clears these
  //   unbudgeted    — categorized, but not attached to a plan line
  // Until budget lines are assignable in the UI, almost everything is
  // unbudgeted, so it is the uncategorized total that is worth surfacing.
  const out = {
    needs: 0, wants: 0, savings: 0,
    uncategorized: 0, unbudgeted: 0, total: 0, work: 0, byLine: {},
    // Foreign charges with no rate for their month yet, by currency. These are
    // deliberately excluded from every colón total rather than guessed at.
    pending: {},
    pendingCount: 0,
  };

  for (const t of rows) {
    if (t.status === 'voided') continue;

    const crc = effectiveCrc(t);

    if (crc == null) {
      out.pending[t.currency] = (out.pending[t.currency] || 0) + t.amount;
      out.pendingCount += 1;
      continue;
    }

    if (t.scope === 'work') { out.work += crc; continue; }
    if (t.kind !== 'expense') continue;

    out.total += crc;
    if (t.cat && out[t.cat] !== undefined) out[t.cat] += crc;
    else out.uncategorized += crc;

    if (t.budgetLineId) out.byLine[t.budgetLineId] = (out.byLine[t.budgetLineId] || 0) + crc;
    else out.unbudgeted += crc;
  }
  return out;
}

export function unreviewedCount(rows) {
  return rows.filter((t) => !t.reviewed && t.status !== 'voided').length;
}
