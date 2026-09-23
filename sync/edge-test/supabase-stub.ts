/**
 * A stand-in for supabase-js, just enough for handler.test.ts.
 *
 * Deliberately NOT inside supabase/functions/. An import map that lives next
 * to the function would be picked up when the function is deployed, and the
 * live function would then write to this stub instead of the database.
 */
export const captured: { rows: any[]; opts: any } = { rows: [], opts: null };

const ACCOUNTS = [
  { id: 'bac-visa-crc', user_id: 'u1', issuer: 'bac', last4: '4477', default_currency: 'CRC', scope: 'personal', active: true },
  { id: 'bac-visa-usd', user_id: 'u1', issuer: 'bac', last4: '4477', default_currency: 'USD', scope: 'personal', active: true },
  { id: 'bncr-usd',     user_id: 'u1', issuer: 'bncr', last4: '0828', default_currency: 'USD', scope: 'work',     active: true },
];

const RULES = [
  { id: 'r1', pattern: 'AUTO MERCADO', match_type: 'contains', priority: 10,
    cat: 'needs', budget_line_id: null, scope: null, merchant_clean: 'Auto Mercado' },
];

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
      return {
        upsert(rows: any[], opts: any) {
          captured.rows = rows;
          captured.opts = opts;
          return chain(rows.map((_, i) => ({ id: `new${i}` })));
        },
      };
    },
  } as any;
}
