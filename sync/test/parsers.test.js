import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmail, normalize, _internal } from '../src/parsers/index.js';

/**
 * Bodies below are real September 2026 emails, copied verbatim, including the
 * pipe-table rendering the Gmail fetch produces.
 */

const BAC = {
  from: 'NotificacionBAC@baccredomatic.cr',
  subject: 'Notificación de transacción AUTO MERCADO HEREDIA 21-09-2026 - 20:38',
  body: ` BAC

| |
|---|
| |

| |
| | | |
|---|---|---|
| | ## Hola SEBASTIAN VEGA CERDAS ##### A continuación le detallamos la transacción realizada: | |

| | |
|---|---|
| Comercio: | AUTO MERCADO HEREDIA |
| Ciudad y país: | HEREDIA, Costa Rica |
| Fecha: | Sep 21, 2026 , 20:38 |
| VISA: | ************4477 |
| Autorización: | 919824 |
| Referencia: | 626502675560 |
| Tipo de Transacción: | COMPRA |
| Monto: | CRC 6,980.00 |

| |
| [](https://wp0w36vs.r.us-east-1.awstrack.me/L0/https:%2F%2Fbac.cr%2FVoucher-Verde/1/x/y=473) |
| Comunicado válido únicamente para Costa Rica. |`,
};

const BAC_AMEX = {
  from: 'NotificacionBAC@baccredomatic.cr',
  subject: 'Notificación de transacción UBER EATS COSTA RICA 20-09-2026 - 18:45',
  body: `| Comercio: | UBER EATS COSTA RICA |
| Ciudad y país: | , Estados Unidos |
| Fecha: | Sep 20, 2026 , 18:45 |
| AMEX: | ***********9654 |
| Autorización: | 004521 |
| Referencia: | 626401998877 |
| Tipo de Transacción: | COMPRA |
| Monto: | CRC 12,450.00 |`,
};

const DAVIVIENDA = {
  from: 'costarica_clientes@davivienda.cr',
  subject: 'Davivienda Autorizaciones',
  body: `Crédito Hipotecario Davivienda Davivienda S.A.

| |
| Estimado cliente: |

| |
| Davivienda le informa de la transacción realizada en: DELTA PIRRO HEREDIA CR, el 21/09/2026, a las 20:51, con la tarjeta DAVIVIENDA VISA INFI terminada en *5131, Autorización #423794, Ref#626502023188, en Colones por 42,239.00 Para mayor información puede ingresar a Banca en Línea www.davivienda.cr[](http://www.davivienda.cr/) |

- - - - - - - - - - - - -`,
};

const PROMERICA = {
  from: 'info@promerica.fi.cr',
  subject: 'Tu transacción fue procesada ¡Revisá tu comprobante!',
  body: `| |
| Hola Sebastian Vega Cerdas |

| |
| ¡Tu transacción fue realizada con éxito! |

| |
|   |
| Te compartimos el detalle: |

| |
| Comercio | DELTA PIRRO HEREDIA CR |
| Tipo de Comercio | GAS STATIONS |
| Ciudad/País | COSTA RICA |
| Fecha/hora | 16 sep 2026 / 17:53 |
| Número de tarjeta | ****-****-****-1763 |
| Número de autorización | 828703 |
| Número de referencia | 4254467398 |
| Monto | CRC: 20,000.00 |

|   |
| Descargá nuestra nueva App: Promerica Móvil |`,
};

const BNCR = {
  from: 'bncontacto@bncr.fi.cr',
  subject: 'Voucher Digital',
  body: `Estimado señor(a): *SEBASTIAN VEGA CERDAS*

Reciba un cordial saludo de parte del Banco Nacional.

Por este medio le hacemos llegar el comprobante de *COMPRA* realizada en *FACEBK *SWRK766KH4 Dublin IE* el *15 de Septiembre de 2026* a las *06:30*

FACEBK *SWRK766KH4 Dublin IE

Sep 15, 2026 - 06:30 VISA ************0828 NRO. AUT: 964732 REF: 625812522165 TOTAL: USD 79.96

Estimado cliente, esta notificación es generada de forma automática.`,
};

// ------------------------------------------------------------- extraction

test('BAC VISA', () => {
  const { ok, record: r } = parseEmail(BAC);
  assert.ok(ok);
  assert.equal(r.merchantRaw, 'AUTO MERCADO HEREDIA');
  assert.equal(r.postedAt, '2026-09-21T20:38:00-06:00');
  assert.equal(r.brand, 'visa');
  assert.equal(r.last4, '4477');
  assert.equal(r.authCode, '919824');
  assert.equal(r.reference, '626502675560');
  assert.equal(r.currency, 'CRC');
  assert.equal(r.amount, 6980);
  assert.equal(r.scope, 'personal');
  assert.equal(r.extId, 'bac:4477:919824:626502675560');
});

test('BAC AMEX — same sender, different card', () => {
  const { ok, record: r } = parseEmail(BAC_AMEX);
  assert.ok(ok);
  assert.equal(r.brand, 'amex');
  assert.equal(r.last4, '9654');
  assert.equal(r.amount, 12450);
});

test('Davivienda', () => {
  const { ok, record: r } = parseEmail(DAVIVIENDA);
  assert.ok(ok);
  assert.equal(r.merchantRaw, 'DELTA PIRRO HEREDIA CR');
  assert.equal(r.postedAt, '2026-09-21T20:51:00-06:00');
  assert.equal(r.last4, '5131');
  assert.equal(r.authCode, '423794');
  assert.equal(r.reference, '626502023188');
  assert.equal(r.currency, 'CRC');
  assert.equal(r.amount, 42239);
});

test('Promerica — carries an MCC', () => {
  const { ok, record: r } = parseEmail(PROMERICA);
  assert.ok(ok);
  assert.equal(r.merchantRaw, 'DELTA PIRRO HEREDIA CR');
  assert.equal(r.mcc, 'GAS STATIONS');
  assert.equal(r.postedAt, '2026-09-16T17:53:00-06:00');
  assert.equal(r.last4, '1763');
  assert.equal(r.amount, 20000);
});

test('BNCR — work scope, USD', () => {
  const { ok, record: r } = parseEmail(BNCR);
  assert.ok(ok);
  assert.equal(r.last4, '0828');
  assert.equal(r.currency, 'USD');
  assert.equal(r.amount, 79.96);
  assert.equal(r.scope, 'work');
  assert.equal(r.amountCrc, null, 'FX is applied by the caller, not the parser');
  assert.match(r.merchantRaw, /FACEBK/);
});

// ------------------------------------------------------------- filtering

test('OTP emails are skipped, not parsed', () => {
  const res = parseEmail({
    from: 'notificacionesotp_cri@baccredomatic.com',
    subject: 'Código Verificación de Compra',
    body: 'Comercio: PedidosYa Restaurantes tarjeta BAC terminada en 4477',
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'ignored');
});

test('SINPE and transfer notices are skipped', () => {
  for (const from of ['alerta@baccredomatic.com', 'notificaciones.gx@davivienda.cr']) {
    const res = parseEmail({ from, subject: 'Notificación de Transferencia', body: 'x' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'ignored');
  }
});

test('Promerica marketing from the same domain is not a transaction', () => {
  const res = parseEmail({
    from: 'info@promerica.fi.cr',
    subject: '🏡 Open House de Parque 160',
    body: 'Tu casa propia empieza acá',
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-a-transaction');
});

test('unknown senders are reported, not guessed at', () => {
  const res = parseEmail({ from: 'promos@example.com', subject: 'Sale', body: 'Monto: CRC 1.00' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unknown-sender');
});

// ------------------------------------------------------------- robustness

test('a truncated email fails loudly rather than storing a partial charge', () => {
  const res = parseEmail({
    from: 'NotificacionBAC@baccredomatic.cr',
    subject: 'Notificación de transacción',
    body: '| Comercio: | AUTO MERCADO |\n| VISA: | ************4477 |',
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'parse-error');
});

test('plain text and pipe-table forms parse identically', () => {
  const plain = {
    ...BAC,
    body: BAC.body.replace(/\|/g, ' '),
  };
  assert.deepEqual(parseEmail(plain).record, parseEmail(BAC).record);
});

test('amounts', () => {
  const { toAmount } = _internal;
  assert.equal(toAmount('6,980.00'), 6980);
  assert.equal(toAmount('42,239.00'), 42239);
  assert.equal(toAmount('79.96'), 79.96);
  assert.equal(toAmount('1,234,567.89'), 1234567.89);
  assert.equal(toAmount('288888.89'), 288888.89);
});

test('normalize collapses layout noise', () => {
  assert.equal(normalize('| a  |   b |\n\n|  |\n| c |'), 'a b\nc');
});

test('ext_id is stable across re-reads of the same email', () => {
  const a = parseEmail(BAC).record.extId;
  const b = parseEmail({ ...BAC, body: `${BAC.body}\n\n| footer noise |` }).record.extId;
  assert.equal(a, b);
});

// ------------------------------------- regressions from real September mail

test('BAC: a charge with an empty Referencia still parses', () => {
  // MICROSOFT *, 5 Sep 2026 — the bank sent "| Referencia: | |"
  const { ok, record: r } = parseEmail({
    from: 'NotificacionBAC@baccredomatic.cr',
    subject: 'Notificación de transacción MICROSOFT   * 05-09-2026 - 20:24',
    body: `| Comercio: | MICROSOFT * |
| Ciudad y país: | , Estados Unidos |
| Fecha: | Sep 5, 2026 , 20:24 |
| AMEX: | ***********9654 |
| Autorización: | 404243 |
| Referencia: | |
| Tipo de Transacción: | COMPRA |
| Monto: | CRC 6,499.00 |`,
  });
  assert.ok(ok);
  assert.equal(r.merchantRaw, 'MICROSOFT *');
  assert.equal(r.reference, null);
  assert.equal(r.amount, 6499);
  assert.equal(r.extId, 'bac:9654:404243:t202609052024');
});

test('BAC: merchant containing a comma is not truncated', () => {
  const { record: r } = parseEmail({
    from: 'NotificacionBAC@baccredomatic.cr',
    subject: 'Notificación de transacción FLUTTERFLOW, INC. 18-09-2026 - 16:57',
    body: `| Comercio: | FLUTTERFLOW, INC. |
| Ciudad y país: | +19192000255, Pais no Definido |
| Fecha: | Sep 18, 2026 , 16:57 |
| VISA: | ************4477 |
| Autorización: | 573561 |
| Referencia: | 626122737411 |
| Tipo de Transacción: | COMPRA |
| Monto: | USD 64.00 |`,
  });
  assert.equal(r.merchantRaw, 'FLUTTERFLOW, INC.');
  assert.equal(r.currency, 'USD');
  assert.equal(r.amount, 64);
});

test('BAC: asterisk inside a merchant name survives', () => {
  const { record: r } = parseEmail({
    from: 'NotificacionBAC@baccredomatic.cr',
    subject: 'Notificación de transacción ONVO*Mas Padel Lindora 07-09-2026 - 20:36',
    body: `| Comercio: | ONVO*Mas Padel Lindora |
| Ciudad y país: | santa ana,san, Costa Rica |
| Fecha: | Sep 7, 2026 , 20:36 |
| VISA: | ************4477 |
| Autorización: | 754535 |
| Referencia: | 625002359514 |
| Tipo de Transacción: | COMPRA |
| Monto: | USD 29.95 |`,
  });
  assert.equal(r.merchantRaw, 'ONVO*Mas Padel Lindora');
  assert.equal(r.amount, 29.95);
});

test('Davivienda: USD is written "en Dolares US por"', () => {
  // ART PADEL, 17 Sep 2026
  const { ok, record: r } = parseEmail({
    from: 'costarica_clientes@davivienda.cr',
    subject: 'Davivienda Autorizaciones',
    body: `| Davivienda le informa de la transacción realizada en: ART PADEL HEREDIA CR, el 17/09/2026, a las 21:06, con la tarjeta DAVIVIENDA VISA INFI terminada en *5131, Autorización #546674, Ref#626103082808, en Dolares US por 18.75 Para mayor información |`,
  });
  assert.ok(ok, 'USD Davivienda charge must parse');
  assert.equal(r.currency, 'USD');
  assert.equal(r.amount, 18.75);
  assert.equal(r.merchantRaw, 'ART PADEL HEREDIA CR');
});

test('Promerica: a second MCC value', () => {
  const { record: r } = parseEmail({
    from: 'info@promerica.fi.cr',
    subject: 'Tu transacción fue procesada ¡Revisá tu comprobante!',
    body: `| Comercio | FARMACIAS CV SAN PABLO SAN PABLO CR |
| Tipo de Comercio | PHARMACIES |
| Ciudad/País | COSTA RICA |
| Fecha/hora | 16 sep 2026 / 17:59 |
| Número de tarjeta | ****-****-****-1763 |
| Número de autorización | 096119 |
| Número de referencia | 4254468310 |
| Monto | CRC: 14,980.00 |`,
  });
  assert.equal(r.mcc, 'PHARMACIES');
  assert.equal(r.merchantRaw, 'FARMACIAS CV SAN PABLO SAN PABLO CR');
  assert.equal(r.amount, 14980);
});

test('BNCR: plain merchant, USD', () => {
  const { record: r } = parseEmail({
    from: 'bncontacto@bncr.fi.cr',
    subject: 'Voucher Digital',
    body: `Por este medio le hacemos llegar el comprobante de *COMPRA* realizada en *CYBER FUEL SAN JOSE CR* el *14 de Septiembre de 2026* a las *08:03*

CYBER FUEL SAN JOSE CR

Sep 14, 2026 - 08:03 VISA ************0828 NRO. AUT: 865679 REF: 625714486324 TOTAL: USD 51.97`,
  });
  assert.equal(r.merchantRaw, 'CYBER FUEL SAN JOSE CR');
  assert.equal(r.amount, 51.97);
  assert.equal(r.scope, 'work');
});
