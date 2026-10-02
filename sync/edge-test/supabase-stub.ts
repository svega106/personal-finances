/**
 * A stand-in for supabase-js, just enough for handler.test.ts.
 *
 * Deliberately NOT inside supabase/functions/. An import map that lives next
 * to the function would be picked up when the function is deployed, and the
 * live function would then write to this stub instead of the database.
 */
export const captured: { rows: any[]; opts: any; removed: string[]; writes: number } = {
  rows: [], opts: null, removed: [], writes: 0,
};

const ACCOUNTS = [
  { id: 'bac-visa-crc', user_id: 'u1', label: 'BAC VISA ₡', issuer: 'bac', last4: '4477', default_currency: 'CRC', scope: 'personal', active: true },
  { id: 'bac-visa-usd', user_id: 'u1', label: 'BAC VISA $', issuer: 'bac', last4: '4477', default_currency: 'USD', scope: 'personal', active: true },
  { id: 'bncr-usd',     user_id: 'u1', label: 'BNCR VISA $ (work)', issuer: 'bncr', last4: '0828', default_currency: 'USD', scope: 'work',     active: true },
];

/** Devices, each with its own switch for new-charge alerts (0012). */
const SUBSCRIPTIONS = [
  { user_id: 'u1', endpoint: 'https://push.example/phone', p256dh: 'k', auth: 'a', notify_charges: true },
  { user_id: 'u1', endpoint: 'https://push.example/laptop', p256dh: 'k', auth: 'a', notify_charges: false },
  { user_id: 'u1', endpoint: 'https://push.example/broken', p256dh: 'k', auth: 'a', notify_charges: true },
  { user_id: 'u1', endpoint: 'https://push.example/gone', p256dh: 'k', auth: 'a', notify_charges: true },
];

const RULES = [
  { id: 'r1', pattern: 'AUTO MERCADO', match_type: 'contains', priority: 10,
    cat: 'needs', budget_line_id: null, scope: null, merchant_clean: 'Auto Mercado' },
];

/** A query that honours .eq(), for the table where the filter is the point. */
function filtered(rows: any[]) {
  const where: [string, unknown][] = [];
  const q: any = {
    select: () => q,
    eq: (col: string, val: unknown) => { where.push([col, val]); return q; },
    then: (ok: any, bad: any) => Promise.resolve({
      data: rows.filter((r) => where.every(([c, v]) => r[c] === v)), error: null,
    }).then(ok, bad),
  };
  return q;
}

/** A statement that fails, as PostgREST reports it. */
function failing(error: { code?: string; message: string }) {
  const p: any = Promise.resolve({ data: null, error });
  p.select = () => p;
  return p;
}

/** Every builder method returns the same thenable, so any chain order works. */
function chain(data: any) {
  const p: any = Promise.resolve({ data, error: null });
  for (const m of ['select', 'eq', 'order', 'limit']) p[m] = () => chain(data);
  return p;
}

export function createClient(_url: string, _key: string, _opts?: unknown) {
  return {
    from(table: string) {
      if (table === 'accounts') return chain(ACCOUNTS);
      if (table === 'rules') return chain(RULES);
      if (table === 'push_subscriptions') {
        return {
          select: () => filtered(SUBSCRIPTIONS),
          delete: () => ({
            eq: (_col: string, endpoint: string) => {
              captured.removed.push(endpoint);
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      return {
        upsert(rows: any[], opts: any) {
          captured.rows = rows;
          captured.opts = opts;
          captured.writes += 1;
          // As Postgres does: one row a check refuses fails the whole statement…
          if (rows.some((r) => String(r.merchant_raw).includes('RECHAZO'))) {
            return failing({ code: '23514', message: 'new row for relation "transactions" violates check constraint "tx_test_ck"' });
          }
          // …and an outage fails it with no Postgres code at all.
          if (rows.some((r) => String(r.merchant_raw).includes('CAIDA'))) {
            return failing({ message: 'connection timed out' });
          }
          // As PostgREST does: the inserted rows come back, with their ids.
          return chain(rows.map((r, i) => ({ id: `new${i}`, ...r })));
        },
      };
    },
  } as any;
}
