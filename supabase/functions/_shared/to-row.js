/**
 * Turning a parsed email into a transactions row.
 *
 * Split out of the Edge Function so it can be tested with `node --test`
 * against the same email samples the parsers use. The function around it is
 * then only HTTP, auth and database calls — the decisions live here.
 */

/**
 * @param {object}  record   what parseEmail() produced
 * @param {object?} hit      what matchRule() produced, or null
 * @param {object?} account  the matching accounts row, or null if unknown
 * @param {string}  userId
 */
export function toTransactionRow({ record: r, hit, account, userId }) {
  // The card an charge landed on decides whether it is work or personal: the
  // BNCR card is the work card no matter what was bought. A rule can override
  // for a specific merchant, and the parser's guess is the fallback when the
  // card is not recognized.
  const scope = account?.scope ?? hit?.scope ?? r.scope;

  return {
    user_id: userId,
    ext_id: r.extId,
    kind: 'expense',
    posted_at: r.postedAt,
    merchant_raw: r.merchantRaw,
    merchant: hit?.merchant ?? r.merchantRaw,
    amount: r.amount,
    currency: r.currency,
    // A foreign charge carries no colón value until the month's rate is set;
    // storing a guess here would quietly corrupt every total that reads it.
    amount_crc: r.currency === 'CRC' ? r.amount : null,
    fx_rate: null,
    account_id: account?.id ?? null,
    counterparty_account_id: null,
    scope,
    // Only money that left your own pocket is awaiting reimbursement. A
    // charge on the company's own card (a work-scope account) is theirs to
    // settle, so it is recorded without ever being chased. A work expense put
    // on a personal card is the opposite, and starts as pending.
    reimbursement: scope === 'work' && account?.scope !== 'work'
      ? { status: 'pending' }
      : null,
    cat: hit?.cat ?? null,
    budget_line_id: hit?.budgetLineId ?? null,
    source: 'email',
    method: 'card',
    status: 'settled',
    // Unreviewed on purpose: these show in the app's review badge until they
    // have been looked at. Nothing arrives already blessed.
    reviewed: false,
    auth_code: r.authCode,
    reference: r.reference ?? null,
    mcc: r.mcc ?? null,
    note: null,
  };
}

/**
 * Which account a charge belongs to.
 *
 * A credit card is identified by issuer, last four and the currency it
 * settles in, because each card here is two accounts — the colón balance and
 * the dollar balance are billed separately.
 *
 * A debit card is not. It spends from one account, and a foreign purchase is
 * debited from that same balance at the bank's rate; only the notification
 * speaks dollars. So when the currency does not match, fall back to the card
 * alone — but only if exactly one account carries it. Two candidates means
 * the card really is currency-split and guessing which half would be worse
 * than leaving the charge unassigned.
 */
export function findAccount(accounts, { issuer, last4, currency }) {
  if (!issuer || !last4) return null;
  const list = accounts ?? [];
  const cur = (a) => a.default_currency ?? a.currency;

  const exact = list.find((a) => a.issuer === issuer && a.last4 === last4 && cur(a) === currency);
  if (exact) return exact;

  const onCard = list.filter((a) => a.issuer === issuer && a.last4 === last4);
  return onCard.length === 1 ? onCard[0] : null;
}
