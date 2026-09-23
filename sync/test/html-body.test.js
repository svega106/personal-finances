/**
 * Parsing a bank email from its HTML.
 *
 * Every parser was written against text the Gmail API had already rendered.
 * The live sync does not use that — Apps Script converts the HTML itself,
 * and its output is a black box that cannot be pinned down by a test here.
 * Davivienda charges silently failed to import for days as a result: the
 * ingest reported "Sentence did not match" and moved its watermark on.
 *
 * The fixture is the real 07:21 charge from 23 September, taken from the
 * message source. Its sentence is split across two <p> elements with every
 * field wrapped in <strong>, which is what makes it awkward.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEmail } from '../../supabase/functions/_shared/parsers.js';
import { htmlToText } from '../../supabase/functions/_shared/html-to-text.js';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(here, 'fixtures', 'davivienda-2026-09-23.html'), 'utf8');
const FROM = 'costarica_clientes@davivienda.cr';
const SUBJECT = 'Davivienda Autorizaciones';

test('the real HTML parses into the right charge', () => {
  const { ok, record, via } = parseEmail({ from: FROM, subject: SUBJECT, html: HTML });
  assert.equal(ok, true);
  assert.equal(via, 'html');
  assert.equal(record.merchantRaw, 'SERVICENTRO SAN JOAQUIN HEREDIA CR');
  assert.equal(record.last4, '5131');
  assert.equal(record.currency, 'CRC');
  assert.equal(record.amount, 5900);
  assert.equal(record.authCode, '673007');
  assert.equal(record.reference, '626607211524');
  assert.equal(record.postedAt, '2026-09-23T07:21:00-06:00');
});

test('a sentence split across two paragraphs is rejoined', () => {
  // "…realizada en:</p><p><strong>SERVICENTRO…" — without a separator at the
  // block boundary the merchant name runs into the preceding word.
  const text = htmlToText(HTML);
  assert.match(text, /realizada en:\s+SERVICENTRO/);
});

test('fields wrapped in <strong> do not lose their separators', () => {
  const text = htmlToText(HTML);
  assert.match(text, /terminada en\s+\*5131,\s*Autorización\s+#673007/);
  assert.match(text, /en\s+Colones\s+por\s+5,900\.00/);
});

test('the HTML is used when the plain text will not parse', () => {
  // The exact failure that happened live: something arrived as the plain
  // body that the parser could not read.
  const res = parseEmail({ from: FROM, subject: SUBJECT, body: 'garbled', html: HTML });
  assert.equal(res.ok, true);
  assert.equal(res.via, 'html', 'fell through to the HTML');
});

test('the plain body is preferred when it works', () => {
  const good = htmlToText(HTML);
  assert.equal(parseEmail({ from: FROM, subject: SUBJECT, body: good, html: HTML }).via, 'plain');
});

test('a failure says what it actually read', () => {
  const res = parseEmail({ from: FROM, subject: SUBJECT, body: 'Davivienda le informa de la transacción realizada en: nothing useful' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'parse-error');
  assert.ok(res.sample, 'a parse error with no sample cannot be diagnosed');
  assert.match(res.sample, /realizada en/);
  assert.deepEqual(res.tried, ['plain']);
});

test('both renderings are named when both were tried', () => {
  const res = parseEmail({ from: FROM, subject: SUBJECT, body: 'junk', html: '<p>also junk</p>' });
  assert.equal(res.ok, false);
  assert.deepEqual(res.tried, ['plain', 'html']);
});

test('an email with neither body nor html is reported, not crashed on', () => {
  const res = parseEmail({ from: FROM, subject: SUBJECT });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'empty');
});


/* ------------------------------------------------------------- Promerica */

const PROM = readFileSync(join(here, 'fixtures', 'promerica-2026-09-16.html'), 'utf8');
const PROM_FROM = 'info@promerica.fi.cr';
const PROM_SUBJECT = 'Tu transacción fue procesada ¡Revisá tu comprobante!';

test('a Promerica voucher parses from its HTML', () => {
  const { ok, record, detail } = parseEmail({ from: PROM_FROM, subject: PROM_SUBJECT, html: PROM });
  assert.equal(ok, true, detail);
  assert.equal(record.merchantRaw, 'DELTA PIRRO HEREDIA CR');
  assert.equal(record.last4, '1763');
  assert.equal(record.currency, 'CRC');
  assert.equal(record.amount, 20000);
  assert.equal(record.authCode, '828703');
  assert.equal(record.reference, '4254467398');
  assert.equal(record.mcc, 'GAS STATIONS');
  assert.equal(record.postedAt, '2026-09-16T17:53:00-06:00');
});

test('the amount is found however the converter lays it out', () => {
  // Promerica wraps only the Monto value in a <p>, unlike every other field
  // in the same email. The layout that produces is an implementation detail
  // of whichever converter ran; that the amount is found is not.
  assert.equal(parseEmail({ from: PROM_FROM, subject: PROM_SUBJECT, html: PROM }).record.amount, 20000);

  // And when it genuinely is split, which is what some converters do.
  const split = 'Comercio DELTA PIRRO HEREDIA CR\nNúmero de tarjeta ****-****-****-1763\n'
    + 'Fecha/hora 16 sep 2026 / 17:53\nNúmero de autorización 828703\n'
    + 'Número de referencia 4254467398\nMonto\nCRC: 20,000.00';
  assert.equal(parseEmail({ from: PROM_FROM, subject: PROM_SUBJECT, body: split }).record.amount, 20000);
});

test('numeric HTML entities are decoded, not left as text', () => {
  // Promerica's spacer cells are &#8202; (hair space).
  const text = htmlToText(PROM);
  assert.ok(!text.includes('&#8202;'), 'raw entity leaked into the text');
  assert.ok(!/&#\d+;/.test(text), 'some numeric entity was left undecoded');
});

test('carriage returns do not survive into the text', () => {
  assert.ok(!htmlToText(PROM).includes('\r'), 'a stray \\r breaks [ \\t]-anchored patterns');
});


/* ------------------------------------------------------ BAC, and Mastercard */

const BACMC = readFileSync(join(here, 'fixtures', 'bac-mastercard-2026-09-23.html'), 'utf8');
const BAC_FROM = 'NotificacionBAC@baccredomatic.cr';
const BAC_SUBJECT = 'Notificación de transacción APPLE.COM/BILL 23-09-2026 - 09:13';

test('a BAC Mastercard notification parses', () => {
  const { ok, record, detail } = parseEmail({ from: BAC_FROM, subject: BAC_SUBJECT, html: BACMC });
  assert.equal(ok, true, detail);
  assert.equal(record.merchantRaw, 'APPLE.COM/BILL');
  assert.equal(record.brand, 'mastercard', 'BAC writes "MASTER:", not "MASTERCARD:"');
  assert.equal(record.last4, '2207');
  assert.equal(record.currency, 'USD');
  assert.equal(record.amount, 4.99);
  assert.equal(record.authCode, '883150');
  assert.equal(record.reference, '626672883150');
  assert.equal(record.postedAt, '2026-09-23T09:13:00-06:00');
});

test('a table row stays on one line', () => {
  // Source HTML is pretty-printed, so the newlines between </td> and the next
  // <td> will split a row in half unless they are collapsed. That split is
  // what made this charge unreadable.
  const text = htmlToText(BACMC);
  assert.match(text, /^Comercio:\s*\|\s*APPLE\.COM\/BILL/m);
  assert.match(text, /^MASTER:\s*\|\s*\*+2207/m);
});

test('a blank field does not swallow the label after it', () => {
  // Some BAC charges carry an empty Referencia. Reading the following line
  // there would file the next label as the reference.
  const body = [
    'Comercio:', 'MICROSOFT*', 'Ciudad y país:', 'REDMOND, US',
    'Fecha:', 'Sep 23, 2026, 09:13', 'VISA:', '************4477',
    'Autorización:', '123456', 'Referencia:', 'Tipo de Transacción:',
    'COMPRA', 'Monto:', 'USD 9.99',
  ].join('\n');
  const { ok, record } = parseEmail({ from: BAC_FROM, subject: 'x', body });
  assert.equal(ok, true);
  assert.equal(record.reference, null, 'blank stays blank');
  assert.equal(record.authCode, '123456');
  assert.equal(record.amount, 9.99);
});

test('the older VISA layout still parses', () => {
  const body = `Comercio: | AUTO MERCADO HEREDIA |
Ciudad y país: | HEREDIA, Costa Rica |
Fecha: | Sep 21, 2026 , 20:38 |
VISA: | ***********4477 |
Autorización: | 004411 |
Referencia: | 626401991234 |
Tipo de Transacción: | COMPRA |
Monto: | CRC 38,500.00 |`;
  const { ok, record } = parseEmail({ from: BAC_FROM, subject: 'x', body });
  assert.equal(ok, true);
  assert.equal(record.brand, 'visa');
  assert.equal(record.last4, '4477');
  assert.equal(record.amount, 38500);
});
