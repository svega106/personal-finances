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
    reimbursement: scope === 'work' ? { status: 'pending' } : null,
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

/** A card is identified by who issued it, its last four, and what it settles in. */
export function findAccount(accounts, { issuer, last4, currency }) {
  return (accounts ?? []).find((a) =>
    a.issuer === issuer
    && a.last4 === last4
    && (a.default_currency ?? a.currency) === currency) ?? null;
}
