/**
 * Bank notification email parsers.
 *
 * Each parser takes the plaintext body of one notification email and returns a
 * normalized record, or null if the email is not a card transaction.
 *
 * The parsers are deliberately tolerant about layout. Depending on how the mail
 * is fetched, the same email arrives either as plain text or as a pipe-delimited
 * rendering of its HTML table, so `normalize()` flattens both to the same shape
 * before any pattern runs.
 *
 * Nothing here guesses. If a required field is missing the parser throws, and the
 * caller logs the email for review rather than storing a half-read charge.
 */

import { htmlToText } from './html-to-text.js';

const TZ = '-06:00'; // America/Costa_Rica, no DST

const MONTHS_EN = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const MONTHS_ES = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
};

/** Senders we accept, and which parser handles each. */
export const SENDERS = {
  'notificacionbac@baccredomatic.cr': 'bac',
  'costarica_clientes@davivienda.cr': 'davivienda',
  'info@promerica.fi.cr': 'promerica',
  'bncontacto@bncr.fi.cr': 'bncr',
};

/**
 * Senders that look like transactions but are not. Listed so the reason for
 * skipping is explicit rather than an accident of the allowlist.
 */
export const IGNORED_SENDERS = {
  'notificacionesotp_cri@baccredomatic.com': 'purchase verification code',
  'alerta@baccredomatic.com': 'transfers and service payments',
  'notificaciones@baccredomatic.cr': 'SINPE transfers',
  'notificaciones.gx@davivienda.cr': 'real-time debits',
  'bancavirtual@davivienda.cr': 'account movements and logins',
  'costarica_estadoscta@davivienda.cr': 'monthly statements',
};

class ParseError extends Error {
  constructor(message, issuer) {
    super(message);
    this.name = 'ParseError';
    this.issuer = issuer;
  }
}

/** Flatten pipe-table rendering and markdown links to a plain, single-spaced body. */
export function normalize(body) {
  return String(body || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links -> their text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\|/g, ' ').replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** "6,980.00" | "42 239,00" -> 6980 | 42239 */
function toAmount(raw, issuer) {
  const cleaned = String(raw).trim().replace(/\s/g, '');
  // Both separators present: the last one is the decimal point.
  let n;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    n = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? Number(cleaned.replace(/\./g, '').replace(',', '.'))
      : Number(cleaned.replace(/,/g, ''));
  } else if (cleaned.includes(',')) {
    // A lone comma is a thousands separator in every sample seen so far,
    // except when exactly two digits follow it and no others do.
    n = /,\d{2}$/.test(cleaned) && !/,\d{3}/.test(cleaned)
      ? Number(cleaned.replace(',', '.'))
      : Number(cleaned.replace(/,/g, ''));
  } else {
    n = Number(cleaned);
  }
  if (!Number.isFinite(n)) throw new ParseError(`Unreadable amount: ${raw}`, issuer);
  return Math.round(n * 100) / 100;
}

function iso(y, m, d, hh, mm) {
  const p = (v, w = 2) => String(v).padStart(w, '0');
  return `${p(y, 4)}-${p(m)}-${p(d)}T${p(hh)}:${p(mm)}:00${TZ}`;
}

/** "Sep 21, 2026 , 20:38" */
function dateEn(text, issuer) {
  const m = text.match(
    /([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s*(\d{4})\s*[,\-]?\s*(\d{1,2}):(\d{2})/,
  );
  if (!m) throw new ParseError(`Unreadable date: ${text}`, issuer);
  const mon = MONTHS_EN[m[1].toLowerCase()];
  if (!mon) throw new ParseError(`Unknown month: ${m[1]}`, issuer);
  return iso(m[3], mon, m[2], m[4], m[5]);
}

/** "16 sep 2026 / 17:53" */
function dateEs(text, issuer) {
  const m = text.match(/(\d{1,2})\s+([A-Za-zÁÉÍÓÚáéíóú]{3})[a-z.]*\s+(\d{4})\s*\/?\s*(\d{1,2}):(\d{2})/);
  if (!m) throw new ParseError(`Unreadable date: ${text}`, issuer);
  const mon = MONTHS_ES[m[2].toLowerCase()];
  if (!mon) throw new ParseError(`Unknown month: ${m[2]}`, issuer);
  return iso(m[3], mon, m[1], m[4], m[5]);
}

function last4(text, issuer) {
  const m = String(text).match(/(\d{4})\s*$/);
  if (!m) throw new ParseError(`No card digits in: ${text}`, issuer);
  return m[1];
}

function need(value, field, issuer) {
  if (value === undefined || value === null || value === '') {
    throw new ParseError(`Missing ${field}`, issuer);
  }
  return value;
}

/**
 * Collapse repeated spaces only. Trailing punctuation is part of the name
 * ("FLUTTERFLOW, INC."), so merchantRaw stays verbatim; tidying belongs in the
 * rules layer, which writes a separate display name.
 */
function cleanMerchant(raw) {
  return String(raw).replace(/\s+/g, ' ').trim();
}

// ----------------------------------------------------------------- BAC

function parseBac(body) {
  const t = normalize(body);
  // Anchored per line, and horizontal whitespace only: a blank field such as
  // "Referencia:" must read as empty, not swallow the following line.
  const field = (label) => {
    const m = t.match(new RegExp(`^${label}\\s*:?[ \\t]*(.*)$`, 'im'));
    const v = m ? m[1].trim() : '';
    return v === '' ? null : v;
  };

  const brandLine = t.match(/^(VISA|AMEX|MASTERCARD)\s*:\s*([*\d]+)\s*$/im);
  if (!brandLine) throw new ParseError('No card line', 'bac');

  const kind = (field('Tipo de Transacci[oó]n') || 'COMPRA').toUpperCase();
  const money = need(field('Monto'), 'Monto', 'bac');
  const mm = money.match(/([A-Z]{3})\s*:?\s*([\d.,]+)/);
  if (!mm) throw new ParseError(`Unreadable Monto: ${money}`, 'bac');

  return {
    issuer: 'bac',
    brand: brandLine[1].toLowerCase(),
    last4: last4(brandLine[2], 'bac'),
    merchantRaw: cleanMerchant(need(field('Comercio'), 'Comercio', 'bac')),
    city: field('Ciudad y pa[ií]s'),
    postedAt: dateEn(need(field('Fecha'), 'Fecha', 'bac'), 'bac'),
    authCode: need(field('Autorizaci[oó]n'), 'Autorización', 'bac'),
    // Some BAC charges arrive with an empty Referencia (seen on MICROSOFT *).
    // The field is genuinely blank, not misread, so it is optional and extId()
    // falls back to the timestamp.
    reference: field('Referencia') || null,
    currency: mm[1],
    amount: toAmount(mm[2], 'bac'),
    txType: kind,
    mcc: null,
  };
}

// ---------------------------------------------------------- Davivienda

function parseDavivienda(body) {
  const t = normalize(body).replace(/\n/g, ' ');

  const m = t.match(
    // "en Colones por 42,239.00" | "en Dolares US por 18.75" — the currency is a
    // word, and the USD form carries a trailing "US".
    //
    // Every comma allows whitespace in front of it. Davivienda wraps each
    // field in <strong>, so a converter that turns a tag into a space yields
    // "23/09/2026 , a las" — which is what made every one of these charges
    // fail to import while the sync reported success.
    /realizada en:\s*(.+?)\s*,\s*el\s*(\d{2})\/(\d{2})\/(\d{4})\s*,\s*a las\s*(\d{1,2}):(\d{2})\s*,\s*con la tarjeta\s*(.+?)\s*terminada en\s*\*?(\d{4})\s*,\s*Autorizaci[oó]n\s*#?\s*(\d+)\s*,\s*Ref\s*#?\s*(\d+)\s*,\s*en\s+(Colones|D[oó]lares)(?:\s+US)?\s+por\s+([\d.,]+)/i,
  );
  if (!m) throw new ParseError('Sentence did not match', 'davivienda');

  return {
    issuer: 'davivienda',
    brand: /amex/i.test(m[7]) ? 'amex' : 'visa',
    last4: m[8],
    merchantRaw: cleanMerchant(m[1]),
    city: null, // runs into the merchant; kept in merchantRaw
    postedAt: iso(m[4], m[3], m[2], m[5], m[6]),
    authCode: m[9],
    reference: m[10],
    currency: /colones/i.test(m[11]) ? 'CRC' : 'USD',
    amount: toAmount(m[12], 'davivienda'),
    txType: 'COMPRA',
    mcc: null,
  };
}

// ----------------------------------------------------------- Promerica

function parsePromerica(body) {
  const t = normalize(body);

  /**
   * Labels carry no colon, and the value may be on the same line or the next.
   *
   * That second case is not hypothetical: Promerica wraps only the Monto
   * value in a <p>, so any converter that breaks at block boundaries leaves
   * "Monto" alone on its line with the amount below it. Every other field of
   * the same email is a plain table cell and stays on one line — which is why
   * a charge would import everything except its amount, and be thrown away
   * for "Missing Monto".
   */
  const field = (label) => {
    const m = t.match(new RegExp(`^${label}[ \\t|]*(.*)$`, 'im'));
    if (!m) return null;

    const clean = (s) => s.replace(/\|/g, ' ').trim();
    const same = clean(m[1]);
    if (same) return same;

    const next = t.slice(m.index + m[0].length)
      .split('\n').map(clean).find((line) => line);
    return next || null;
  };

  const money = need(field('Monto'), 'Monto', 'promerica');
  const mm = money.match(/([A-Z]{3})\s*:?\s*([\d.,]+)/);
  if (!mm) throw new ParseError(`Unreadable Monto: ${money}`, 'promerica');

  return {
    issuer: 'promerica',
    brand: null,
    last4: last4(need(field('N[uú]mero de tarjeta'), 'tarjeta', 'promerica'), 'promerica'),
    merchantRaw: cleanMerchant(need(field('Comercio(?! Tipo)'), 'Comercio', 'promerica')),
    city: field('Ciudad/Pa[ií]s'),
    postedAt: dateEs(need(field('Fecha/hora'), 'Fecha/hora', 'promerica'), 'promerica'),
    authCode: need(field('N[uú]mero de autorizaci[oó]n'), 'autorización', 'promerica'),
    reference: need(field('N[uú]mero de referencia'), 'referencia', 'promerica'),
    currency: mm[1],
    amount: toAmount(mm[2], 'promerica'),
    txType: 'COMPRA',
    mcc: field('Tipo de Comercio'),
  };
}

// ---------------------------------------------------------------- BNCR

function parseBncr(body) {
  const flat = normalize(body).replace(/\n/g, ' ');

  const m = flat.match(
    /([A-Za-z]{3}\s+\d{1,2},\s*\d{4})\s*-\s*(\d{1,2}:\d{2})\s+(VISA|AMEX|MASTERCARD)\s+([*\d]+)\s+NRO\.?\s*AUT:?\s*(\d+)\s+REF:?\s*(\d+)\s+TOTAL:?\s*([A-Z]{3})\s*([\d.,]+)/i,
  );
  if (!m) throw new ParseError('Voucher line did not match', 'bncr');

  // Merchant: the phrase after "realizada en", before " el <date>". BNCR wraps
  // emphasis in asterisks, which also appear inside merchant descriptors
  // ("FACEBK *SWRK766KH4"), so they are flattened to spaces for this match only.
  const mer = flat
    .replace(/\*/g, ' ')
    .replace(/\s+/g, ' ')
    .match(/realizada en\s+(.+?)\s+el\s+\d{1,2}\s+de\s+\w+/i);

  return {
    issuer: 'bncr',
    brand: m[3].toLowerCase(),
    last4: last4(m[4], 'bncr'),
    merchantRaw: cleanMerchant(mer ? mer[1] : 'UNKNOWN'),
    city: null,
    postedAt: dateEn(`${m[1]} , ${m[2]}`, 'bncr'),
    authCode: m[5],
    reference: m[6],
    currency: m[7],
    amount: toAmount(m[8], 'bncr'),
    txType: 'COMPRA',
    mcc: null,
  };
}

const PARSERS = {
  bac: parseBac,
  davivienda: parseDavivienda,
  promerica: parsePromerica,
  bncr: parseBncr,
};

/**
 * `{issuer}:{last4}:{auth}:{ref}` — stable for the life of the charge.
 *
 * A few charges arrive with no reference number. Those fall back to the
 * timestamp, which comes from the email body and so is equally stable across
 * re-reads: auth code + card + minute is unique in practice.
 */
export function extId(r) {
  const ref = r.reference || `t${r.postedAt.slice(0, 16).replace(/[-T:]/g, '')}`;
  return `${r.issuer}:${r.last4}:${r.authCode}:${ref}`;
}

/**
 * Parse one email.
 *
 * Returns { ok: true, record } | { ok: false, reason, detail, sample }.
 * Never throws: the caller decides what to do with an unreadable email.
 *
 * Two renderings are tried. The plain-text body is whatever the fetcher
 * produced — for Apps Script that is `getPlainBody()`, a black box that
 * varies by how the bank builds its HTML. If that fails and the raw HTML was
 * sent too, the HTML is converted here, by code that is under test, and tried
 * again. One bank's layout should not be able to break the import silently.
 */
export function parseEmail({ from, subject = '', body = '', html = '' }) {
  const addr = String(from || '').toLowerCase().match(/[\w.+-]+@[\w.-]+/)?.[0] || '';

  if (IGNORED_SENDERS[addr]) {
    return { ok: false, reason: 'ignored', detail: IGNORED_SENDERS[addr] };
  }

  const issuer = SENDERS[addr];
  if (!issuer) return { ok: false, reason: 'unknown-sender', detail: addr };

  // Promerica and BNCR use one sender for marketing as well as vouchers.
  const anyText = `${body}\n${html}`;
  if (issuer === 'promerica' && !/transacci[oó]n/i.test(subject) && !/Tipo de Comercio/i.test(anyText)) {
    return { ok: false, reason: 'not-a-transaction', detail: subject };
  }
  if (issuer === 'bncr' && !/NRO\.?\s*AUT/i.test(anyText)) {
    return { ok: false, reason: 'not-a-transaction', detail: subject };
  }

  const candidates = [];
  if (body) candidates.push({ label: 'plain', text: body });
  if (html) candidates.push({ label: 'html', text: htmlToText(html) });
  if (!candidates.length) return { ok: false, reason: 'empty', detail: 'no body' };

  let lastErr = null;
  for (const c of candidates) {
    try {
      const record = PARSERS[issuer](c.text);
      record.extId = extId(record);
      record.amountCrc = record.currency === 'CRC' ? record.amount : null; // FX applied by caller
      record.scope = record.issuer === 'bncr' ? 'work' : 'personal';
      record.source = 'email';
      record.method = 'card';
      record.status = 'pending';
      return { ok: true, record, via: c.label };
    } catch (err) {
      lastErr = { err, c };
    }
  }

  // A parse error with no sample of what was read is undiagnosable — the only
  // way to find out is to go and fetch the email by hand. Send back enough to
  // see the shape of it.
  return {
    ok: false,
    reason: 'parse-error',
    detail: lastErr.err.message,
    issuer,
    sample: excerpt(lastErr.c.text),
    tried: candidates.map((c) => c.label),
  };
}

/** A readable slice around whatever the parser was looking for. */
function excerpt(text, len = 260) {
  const t = normalize(text).replace(/\n/g, ' ⏎ ');
  const anchor = t.search(/realizada en|Comercio|NRO\.?\s*AUT|Tipo de Comercio|Monto/i);
  const from = anchor > 60 ? anchor - 60 : 0;
  return (from ? '…' : '') + t.slice(from, from + len) + (t.length > from + len ? '…' : '');
}

export const _internal = { normalize, toAmount, dateEn, dateEs, cleanMerchant };
