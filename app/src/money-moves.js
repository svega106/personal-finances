/**
 * Money that moves between your own accounts, and money that comes in.
 *
 * Two kinds of transaction the schema has always allowed and the app never
 * wrote until now:
 *
 *   transfer — savings to a credit card. One row carries both sides:
 *              `account_id` is where the money left, `counterparty_account_id`
 *              where it arrived, and `account_balances` subtracts it from the
 *              first and adds it to the second. A card's balance is negative
 *              (what is owed), so adding to it is paying it down. Writing a
 *              second row for the other side would count the payment twice.
 *   income   — money arriving from outside, a paycheck. One account, no
 *              counterparty.
 *
 * Neither is spending: `spendTotals` has always skipped every kind but
 * 'expense', and a transfer can carry no category (0001's tx_transfer_cat_ck).
 *
 * No DOM and no repository, so all of it is under test.
 */
import { uid, money } from './state.js';
import { crDay, crNoon } from './cr-date.js';

/** A transfer comes from savings — where the paycheck lands. */
export function transferSources(accounts) {
  return (accounts ?? []).filter((a) => a.type === 'savings');
}

/**
 * And goes to a credit card: a `card` row. The debit card on Ahorros ₡ is
 * recorded on that savings row, so it is never offered — money moved there
 * would be moved into the account it came from. The company's card is left
 * out too: the company pays it.
 */
export function transferDestinations(accounts) {
  return (accounts ?? []).filter((a) => a.type === 'card' && a.scope !== 'work');
}

/** Income lands in savings. */
export function incomeAccounts(accounts) {
  return (accounts ?? []).filter((a) => a.type === 'savings');
}

const positive = (n) => Number.isFinite(n) && n > 0;

/**
 * A colón account paying a dollar card, or the other way round. The bank
 * converts at its own rate that day, so what left savings and what came off
 * the card are two figures, and both are asked for. The same currency on both
 * ends is one figure, as it always was.
 */
export function crossCurrency(source, dest) {
  return !!source && !!dest && source.currency !== dest.currency;
}

/**
 * Why a transfer cannot be saved, or null.
 *
 * `balance` is the source's row from `account_balances`. `original` is the
 * transfer being edited, if any: its amount is already out of the source's
 * balance, so it counts as available again for the edit.
 */
export function validateTransfer({ source, dest, amount, destAmount, date, balance, original }) {
  if (!source) return 'Choose the account the money comes from.';
  if (source.type !== 'savings') return 'A transfer to a card comes from a savings account.';
  if (!dest) return 'Choose the card it pays.';
  if (dest.type !== 'card') return 'Only a credit card can be paid with a transfer.';
  if (!positive(amount)) return 'The amount must be more than zero.';
  if (crossCurrency(source, dest) && !positive(destAmount)) {
    return `Enter how much came off ${dest.label}, in ${dest.currency === 'USD' ? 'dollars' : 'colones'}.`;
  }
  if (!date) return 'Choose a date.';

  // Without a recorded balance there is no knowing what the account holds,
  // and so no way to promise this does not overdraw it.
  if (!balance || !balance.hasSnapshot) {
    return `Record what ${source.label} holds first (Accounts → tap it) — without a balance there is no telling whether this would overdraw it.`;
  }

  const giveBack = original && original.kind === 'transfer'
    && original.accountId === source.id && original.currency === source.currency
    ? original.amount : 0;
  const available = balance.currentBalance + giveBack;

  if (amount > available + 1e-9) {
    return `That would take ${source.label} below zero — ${fmt(Math.max(0, available), source.currency)} is available.`;
  }
  return null;
}

/** Why an income cannot be saved, or null. */
export function validateIncome({ account, amount, date }) {
  if (!account) return 'Choose the account it went into.';
  if (account.type !== 'savings') return 'Income goes into a savings account.';
  if (!positive(amount)) return 'The amount must be more than zero.';
  if (!date) return 'Choose a date.';
  return null;
}

/**
 * The instant to store for a picked day.
 *
 * The sheet offers a day, not a time. Rebuilding an untouched day as noon
 * would throw away the time it was recorded — the same rule the expense sheet
 * follows.
 */
function postedAt(existing, date) {
  return existing?.postedAt && crDay(existing.postedAt) === date ? existing.postedAt : crNoon(date);
}

function base(existing) {
  return existing ?? {
    id: null,
    extId: `manual:${uid()}${Date.now().toString(36)}`,
    source: 'manual',
    reimbursement: null,
  };
}

/**
 * The transaction for a transfer from `source` to the card `dest`.
 *
 * `destAmount` is used only across currencies, and is then what came off the
 * card in its own currency. Within one currency it is ignored, so a stale
 * figure from a form that was switched back can never be written.
 */
export function transferRow({ source, dest, amount, destAmount, date, note, existing }) {
  return {
    ...base(existing),
    kind: 'transfer',
    postedAt: postedAt(existing, date),
    merchant: `To ${dest.label}`,
    merchantRaw: `To ${dest.label}`,
    amount,
    // In the source's currency: that is what left the account.
    currency: source.currency,
    amountCrc: source.currency === 'CRC' ? amount : null,
    fxRate: null,
    accountId: source.id,
    counterpartyAccountId: dest.id,
    // What arrived, in the card's currency; the balance view uses it as is.
    counterpartyAmount: crossCurrency(source, dest) ? destAmount : null,
    scope: 'personal',
    cat: null,
    budgetLineId: null,
    method: 'transfer',
    status: 'settled',
    reviewed: true,
    note: String(note ?? '').trim() || null,
  };
}

/** The transaction for money coming into `account`. */
export function incomeRow({ account, amount, date, from, note, existing }) {
  const name = String(from ?? '').trim() || 'Income';
  return {
    ...base(existing),
    kind: 'income',
    postedAt: postedAt(existing, date),
    merchant: name,
    merchantRaw: name,
    amount,
    currency: account.currency,
    amountCrc: account.currency === 'CRC' ? amount : null,
    fxRate: null,
    accountId: account.id,
    counterpartyAccountId: null,
    counterpartyAmount: null,
    scope: 'personal',
    cat: null,
    budgetLineId: null,
    method: 'transfer',
    status: 'settled',
    reviewed: true,
    note: String(note ?? '').trim() || null,
  };
}

function fmt(amount, currency) {
  if (currency === 'CRC') return money(amount);
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
