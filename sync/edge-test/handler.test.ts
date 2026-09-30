/**
 * The ingest function as an HTTP endpoint.
 *
 * Boots the real handler with a stubbed database and drives it with real
 * requests, so this covers what the node tests cannot: the shared-secret
 * check, the error codes, the exact options the write is made with, and the
 * notification a new charge sends (web-push is stubbed too).
 *
 *   cd sync/edge-test && deno run --allow-net --allow-env --allow-read handler.test.ts
 */
import { captured } from './supabase-stub.ts';
import { pushed } from './web-push-stub.ts';

Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-not-real');
Deno.env.set('INGEST_SECRET', 'topsecret');
Deno.env.set('VAPID_PUBLIC_KEY', 'public-not-real');
Deno.env.set('VAPID_PRIVATE_KEY', 'private-not-real');
Deno.env.set('VAPID_SUBJECT', 'mailto:test@example.com');

await import('../../supabase/functions/ingest-email/index.ts');
await new Promise((r) => setTimeout(r, 300));

const PORT = 8000;
const call = (init: RequestInit & { secret?: string }) =>
  fetch(`http://localhost:${PORT}/`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.secret ? { 'x-ingest-secret': init.secret } : {}),
    },
  });

/** A real September 2026 BAC notification. */
const BAC = {
  from: 'NotificacionBAC@baccredomatic.cr',
  subject: 'Notificación de transacción AUTO MERCADO HEREDIA',
  body: `| Comercio: | AUTO MERCADO HEREDIA |
| Ciudad y país: | HEREDIA, Costa Rica |
| Fecha: | Sep 21, 2026 , 20:38 |
| VISA: | ***********4477 |
| Autorización: | 004411 |
| Referencia: | 626401991234 |
| Tipo de Transacción: | COMPRA |
| Monto: | CRC 38,500.00 |`,
};

const NOISE = { from: 'newsletter@example.com', subject: 'Sale!', body: 'buy things' };

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
  if (!ok) failures++;
}

let r = await call({ method: 'GET', secret: 'topsecret' });
check('GET is rejected', r.status === 405, String(r.status));
await r.body?.cancel();

r = await call({ method: 'POST', body: '{"messages":[]}' });
check('no secret is rejected', r.status === 401, String(r.status));
await r.body?.cancel();

r = await call({ method: 'POST', body: '{"messages":[]}', secret: 'wrong-but-same-len' });
check('wrong secret is rejected', r.status === 401, String(r.status));
await r.body?.cancel();

r = await call({ method: 'POST', body: '{"messages":[]}', secret: 'topsecre' });
check('a truncated secret is rejected', r.status === 401, String(r.status));
await r.body?.cancel();

r = await call({ method: 'POST', body: 'not json at all', secret: 'topsecret' });
check('malformed JSON is rejected', r.status === 400, String(r.status));
await r.body?.cancel();

r = await call({
  method: 'POST', secret: 'topsecret',
  body: JSON.stringify({ messages: new Array(201).fill(BAC) }),
});
check('an oversized batch is refused', r.status === 413, String(r.status));
await r.body?.cancel();

r = await call({
  method: 'POST', secret: 'topsecret',
  body: JSON.stringify({ messages: [BAC, NOISE] }),
});
const body = await r.json();
check('a valid post succeeds', r.status === 200, String(r.status));
check('the charge is imported', body.imported === 1, JSON.stringify(body));
check('the unrelated email is reported, not imported',
  body.skipped.length === 1 && body.skipped[0].reason === 'unknown-sender',
  JSON.stringify(body.skipped));

check('a re-run cannot overwrite an edited row',
  captured.opts?.ignoreDuplicates === true, JSON.stringify(captured.opts));
check('dedupe is on user + ext_id',
  captured.opts?.onConflict === 'user_id,ext_id', JSON.stringify(captured.opts));
check('the charge landed on the colón half of the card',
  captured.rows[0]?.account_id === 'bac-visa-crc', String(captured.rows[0]?.account_id));
check('the rule set category and display name',
  captured.rows[0]?.cat === 'needs' && captured.rows[0]?.merchant === 'Auto Mercado',
  JSON.stringify(captured.rows[0]));
check('it arrives unreviewed', captured.rows[0]?.reviewed === false,
  String(captured.rows[0]?.reviewed));
check('a charge from last week is imported without a notification',
  body.notified?.alerts === 0 && pushed.length === 0, JSON.stringify(body.notified));

/* ---- a charge made a few minutes ago is announced ---- */

/** The BAC email's own date format, in Costa Rica: "Sep 21, 2026 , 20:38". */
function bacDate(when: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Costa_Rica', month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(when).map((x) => [x.type, x.value]));
  return `${p.month} ${p.day}, ${p.year} , ${p.hour}:${p.minute}`;
}
const FRESH = { ...BAC, body: BAC.body.replace('Sep 21, 2026 , 20:38', bacDate(new Date(Date.now() - 5 * 60e3))) };

r = await call({ method: 'POST', secret: 'topsecret', body: JSON.stringify({ messages: [FRESH] }) });
const fresh = await r.json();
check('a fresh charge still imports, whatever the push service does',
  r.status === 200 && fresh.imported === 1, JSON.stringify(fresh));
check('it is announced on the device with new charges on, and only there',
  pushed.length === 1 && pushed[0].endpoint === 'https://push.example/phone',
  JSON.stringify(pushed.map((p) => p.endpoint)));
check('the notification says what, where and what next',
  pushed[0]?.payload.title === '₡38,500 at Auto Mercado'
    && pushed[0]?.payload.body === 'BAC VISA ₡ ••4477 · Essentials'
    && pushed[0]?.payload.url === '/?view=transactions&tx=new0'
    && pushed[0]?.payload.kind === 'charge',
  JSON.stringify(pushed[0]?.payload));
check('sent at high urgency, kept a few hours for an offline phone',
  pushed[0]?.options.urgency === 'high' && pushed[0]?.options.TTL === 6 * 3600,
  JSON.stringify(pushed[0]?.options));
check('a device the push service says is gone is removed',
  captured.removed.length === 1 && captured.removed[0] === 'https://push.example/gone',
  JSON.stringify(captured.removed));
check('the report says what happened',
  fresh.notified?.delivered === 1 && fresh.notified?.devices === 3
    && fresh.notified?.removedDevices === 1 && fresh.notified?.errors.length === 1,
  JSON.stringify(fresh.notified));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
Deno.exit(failures ? 1 : 0);
