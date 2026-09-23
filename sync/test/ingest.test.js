/**
 * The mapping from a parsed bank email to a transactions row.
 *
 * Uses the same real September 2026 emails the parser tests use, so a change
 * that breaks the shape the database expects is caught here rather than in
 * production by a row that quietly went to the wrong card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmail } from '../../supabase/functions/_shared/parsers.js';
import { matchRule } from '../../supabase/functions/_shared/classify.js';
import { toTransactionRow, findAccount } from '../../supabase/functions/_shared/to-row.js';

const USER = '11111111-1111-1111-1111-111111111111';

/** Mirrors what 0002/0004 seed: every card split by the currency it settles in. */
const ACCOUNTS = [
  { id: 'bac-visa-crc', issuer: 'bac', last4: '4477', default_currency: 'CRC', scope: 'personal' },
  { id: 'bac-visa-usd', issuer: 'bac', last4: '4477', default_currency: 'USD', scope: 'personal' },
  { id: 'bac-amex-crc', issuer: 'bac', last4: '9654', default_currency: 'CRC', scope: 'personal' },
  { id: 'davi-crc', issuer: 'davivienda', last4: '5131', default_currency: 'CRC', scope: 'personal' },
  { id: 'davi-usd', issuer: 'davivienda', last4: '5131', default_currency: 'USD', scope: 'personal' },
  { id: 'prom-crc', issuer: 'promerica', last4: '1763', default_currency: 'CRC', scope: 'personal' },
  { id: 'bncr-crc', issuer: 'bncr', last4: '0828', default_currency: 'CRC', scope: 'work' },
  { id: 'bncr-usd', issuer: 'bncr', last4: '0828', default_currency: 'USD', scope: 'work' },
  // A debit card on the colón savings account. One row, not two: it is not
  // split by currency the way a credit card is.
  { id: 'ahorros-crc', issuer: 'bac', last4: '2207', default_currency: 'CRC', scope: 'personal' },
];

const RULES = [
  { id: 'r1', pattern: 'AUTO MERCADO', matchType: 'contains', priority: 10,
    cat: 'needs', budgetLineId: null, scope: null, merchantClean: 'Auto Mercado' },
  { id: 'r2', pattern: 'UBER EATS', matchType: 'contains', priority: 20,
    cat: 'wants', budgetLineId: null, scope: null, merchantClean: 'Uber Eats' },
];

function ingest(email, { accounts = ACCOUNTS, rules = RULES } = {}) {
  const parsed = parseEmail(email);
  assert.equal(parsed.ok, true, `expected a parse: ${JSON.stringify(parsed)}`);
  const r = parsed.record;
  return toTransactionRow({
    record: r,
    hit: matchRule(rules, r.merchantRaw, r.mcc),
    account: findAccount(accounts, r),
    userId: USER,
  });
}

const BAC_CRC = {
  from: 'NotificacionBAC@baccredomatic.cr',
  subject: 'Notificación de transacción AUTO MERCADO HEREDIA 21-09-2026 - 20:38',
  body: `| Comercio: | AUTO MERCADO HEREDIA |
| Ciudad y país: | HEREDIA, Costa Rica |
| Fecha: | Sep 21, 2026 , 20:38 |
| VISA: | ***********4477 |
| Autorización: | 004411 |
| Referencia: | 626401991234 |
| Tipo de Transacción: | COMPRA |
| Monto: | CRC 38,500.00 |`,
};

const BAC_USD = {
  from: 'NotificacionBAC@baccredomatic.cr',
  subject: 'Notificación de transacción AWS 20-09-2026 - 04:12',
  body: `| Comercio: | AMAZON WEB SERVICES |
| Ciudad y país: | SEATTLE, Estados Unidos |
| Fecha: | Sep 20, 2026 , 04:12 |
| VISA: | ***********4477 |
| Autorización: | 771200 |
| Referencia: | 626409900011 |
| Tipo de Transacción: | COMPRA |
| Monto: | USD 42.30 |`,
};

// The real BNCR voucher, verbatim â and note it is a USD charge, which is
// why the work account below has to be the dollar half.
const BNCR_WORK = {
  from: 'bncontacto@bncr.fi.cr',
  subject: 'Voucher Digital',
  body: `Estimado señor(a): *SEBASTIAN VEGA CERDAS*

Reciba un cordial saludo de parte del Banco Nacional.

Por este medio le hacemos llegar el comprobante de *COMPRA* realizada en *FACEBK *SWRK766KH4 Dublin IE* el *15 de Septiembre de 2026* a las *06:30*

FACEBK *SWRK766KH4 Dublin IE

Sep 15, 2026 - 06:30 VISA ************0828 NRO. AUT: 964732 REF: 625812522165 TOTAL: USD 79.96

Estimado cliente, esta notificación es generada de forma automática.`,
};

test('a colón charge lands on the colón half of the card', () => {
  const row = ingest(BAC_CRC);
  assert.equal(row.account_id, 'bac-visa-crc');
  assert.equal(row.currency, 'CRC');
  assert.equal(row.amount, 38500);
  assert.equal(row.amount_crc, 38500);
});

test('a dollar charge on the same card lands on the dollar half', () => {
  const row = ingest(BAC_USD);
  assert.equal(row.account_id, 'bac-visa-usd', 'same card, different currency, different account');
  assert.equal(row.currency, 'USD');
  assert.equal(row.amount, 42.30);
});

test('a foreign charge stores no colón value until a rate is set', () => {
  const row = ingest(BAC_USD);
  assert.equal(row.amount_crc, null, 'a guessed colón value would corrupt every total');
  assert.equal(row.fx_rate, null);
});

test('rules set the category and the display name', () => {
  const row = ingest(BAC_CRC);
  assert.equal(row.cat, 'needs');
  assert.equal(row.merchant, 'Auto Mercado');
  assert.equal(row.merchant_raw, 'AUTO MERCADO HEREDIA', 'the original is kept');
});

test('an unmatched merchant is left uncategorized rather than guessed', () => {
  const row = ingest(BAC_USD);
  assert.equal(row.cat, null);
  assert.equal(row.merchant, row.merchant_raw);
});

test('the work card marks a charge as work whatever was bought', () => {
  const row = ingest(BNCR_WORK);
  assert.equal(row.account_id, 'bncr-usd', 'a USD voucher belongs to the dollar half');
  assert.equal(row.scope, 'work');
});

test('a charge on the company card is not awaiting reimbursement', () => {
  // The company pays that card directly, so the money never left his pocket
  // and there is nothing to claim back.
  assert.equal(ingest(BNCR_WORK).reimbursement, null);
});

test('a work charge on a personal card is awaiting reimbursement', () => {
  // The same rule from the other side: his money until it comes back. The
  // scope is set by hand in the app, which the ingest respects.
  const rules = [{ id: 'rw', pattern: 'AUTO MERCADO', matchType: 'contains', priority: 1,
    cat: 'needs', budgetLineId: null, scope: 'work', merchantClean: null }];
  const row = ingest(BAC_CRC, { rules, accounts: [] });
  assert.equal(row.scope, 'work');
  assert.deepEqual(row.reimbursement, { status: 'pending' });
});

test('a personal charge carries no reimbursement', () => {
  assert.equal(ingest(BAC_CRC).reimbursement, null);
});

test('everything from email arrives unreviewed', () => {
  for (const e of [BAC_CRC, BAC_USD, BNCR_WORK]) {
    assert.equal(ingest(e).reviewed, false);
  }
});

test('an unrecognized card still imports, with no account attached', () => {
  const row = ingest(BAC_CRC, { accounts: [] });
  assert.equal(row.account_id, null, 'the charge is kept; it can be assigned by hand');
  assert.equal(row.scope, 'personal', 'falls back to the parser rather than dropping the row');
  assert.equal(row.amount, 38500);
});

test('ext_id is stable across re-imports of the same email', () => {
  assert.equal(ingest(BAC_CRC).ext_id, ingest(BAC_CRC).ext_id);
});

test('ext_id differs between two different charges', () => {
  assert.notEqual(ingest(BAC_CRC).ext_id, ingest(BAC_USD).ext_id);
});

test('a rule may move a merchant to work even on a personal card', () => {
  const rules = [{ id: 'r9', pattern: 'AUTO MERCADO', matchType: 'contains', priority: 1,
    cat: 'needs', budgetLineId: null, scope: 'work', merchantClean: null }];
  // The card still wins: it is the card that gets billed.
  assert.equal(ingest(BAC_CRC, { rules }).scope, 'personal');
  // With no known card, the rule decides.
  assert.equal(ingest(BAC_CRC, { rules, accounts: [] }).scope, 'work');
});

test('a non-transaction email is not turned into a row', () => {
  const res = parseEmail({
    from: 'notificacionesotp_cri@baccredomatic.com',
    subject: 'Su código', body: 'Su código es 123456',
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'ignored');
});


/* ------------------------------------------- a debit card on a savings account */

const BAC_MC_USD = {
  from: 'NotificacionBAC@baccredomatic.cr',
  subject: 'Notificación de transacción APPLE.COM/BILL',
  body: `Comercio: | APPLE.COM/BILL |
Ciudad y país: | CUPERTINO, Pais no Definido |
Fecha: | Sep 23, 2026 , 09:13 |
MASTER: | ************2207 |
Autorización: | 883150 |
Referencia: | 626672883150 |
Tipo de Transacción: | COMPRA |
Monto: | USD 4.99 |`,
};

const BAC_MC_CRC = {
  ...BAC_MC_USD,
  body: BAC_MC_USD.body.replace('USD 4.99', 'CRC 35,000.00').replace('APPLE.COM/BILL', 'SUPERMERCADO'),
};

test('a colón charge on the debit card lands on the savings account', () => {
  const row = ingest(BAC_MC_CRC);
  assert.equal(row.account_id, 'ahorros-crc');
  assert.equal(row.amount, 35000);
});

test('a dollar charge on that same card lands there too', () => {
  // The card is not currency-split: a foreign purchase is debited from the
  // colón balance at the bank's rate, and only the notification says USD.
  // Matching on currency alone would have left this unassigned.
  const row = ingest(BAC_MC_USD);
  assert.equal(row.account_id, 'ahorros-crc');
  assert.equal(row.currency, 'USD');
  assert.equal(row.amount, 4.99);
  assert.equal(row.amount_crc, null, 'still needs the month rate, like any foreign charge');
});

test('a split credit card never falls back across its two halves', () => {
  // BAC VISA 4477 exists twice, once per currency. A charge in a third
  // currency must stay unassigned rather than pick one at random.
  const odd = { ...BAC_USD, body: BAC_USD.body.replace('USD 42.30', 'EUR 42.30') };
  assert.equal(ingest(odd).account_id, null);
});

test('an exact currency match still wins over the fallback', () => {
  assert.equal(ingest(BAC_CRC).account_id, 'bac-visa-crc');
  assert.equal(ingest(BAC_USD).account_id, 'bac-visa-usd');
});
