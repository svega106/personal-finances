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
