/**
 * The ingest function as an HTTP endpoint.
 *
 * Boots the real handler with a stubbed database and drives it with real
 * requests, so this covers what the node tests cannot: the shared-secret
 * check, the error codes, and the exact options the write is made with.
 *
 *   cd sync/edge-test && deno run --allow-net --allow-env --allow-read handler.test.ts
 */
import { captured } from './supabase-stub.ts';

Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-not-real');
Deno.env.set('INGEST_SECRET', 'topsecret');

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

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
Deno.exit(failures ? 1 : 0);
