-- 0008 — a debit-card charge is converted the moment it arrives.
--
-- 0007 converted foreign charges using the rate for the month they were made
-- in, and left out anything it could not convert. For a credit card that is
-- right: a dollar charge sits on a dollar balance and is genuinely unsettled
-- until the month closes, so folding in a guess would misstate what is owed.
--
-- A debit card is the opposite. The bank converts at its own rate the moment
-- the charge lands, and the colones are gone. Holding the charge out of the
-- balance until a month rate is entered reports a balance that is too high,
-- for a transaction that has already happened.
--
-- So the two are treated differently, by account type:
--
--   card                  the month's own rate, or nothing. Still settling.
--   savings/cash/invest   the month's rate, falling back to the most recent
--                         rate on or before it. Already spent; an approximate
--                         figure beats a balance that is silently wrong.
--
-- The email only ever says "USD 4.99" — the bank's own rate that day is not
-- in it — so an approximation is the best available, and it is out by a
-- fraction of a percent. A row can still be corrected by hand.
--
-- Idempotent: replaces the view.

create or replace view public.account_balances as
with last_snap as (
  select distinct on (account_id)
         account_id, user_id, as_of, balance, currency
  from public.balance_snapshots
  order by account_id, as_of desc
),
movement as (
  select
    a.id as account_id,
    sum(
      case
        when t.kind = 'income'                           then  conv.amount
        when t.kind = 'adjustment'                       then  conv.amount
        when t.kind = 'transfer'
             and t.counterparty_account_id = a.id        then  conv.amount
        when t.kind = 'transfer' and t.account_id = a.id then -conv.amount
        when t.kind = 'expense'                          then -conv.amount
        else 0
      end
    ) filter (where conv.amount is not null) as moved,
    count(*) filter (where conv.amount is null) as pending_fx
  from public.accounts a
  join public.transactions t
    on t.user_id = a.user_id
   and t.status <> 'voided'
   and (t.account_id = a.id or t.counterparty_account_id = a.id)
  left join last_snap s on s.account_id = a.id

  -- The charge's own month.
  left join public.fx_rates fx
    on fx.user_id = t.user_id
   and fx.month = to_char(t.posted_at at time zone 'America/Costa_Rica', 'YYYY-MM')
   and fx.currency = t.currency
  left join public.fx_rates fx2
    on fx2.user_id = t.user_id
   and fx2.month = to_char(t.posted_at at time zone 'America/Costa_Rica', 'YYYY-MM')
   and fx2.currency = a.default_currency

  -- The most recent rate on or before the charge's month. Always looked up;
  -- whether it may be used is decided in the CASE below, where the rule is
  -- readable. (Putting the account-type test in this join's ON clause left
  -- the rate null even when it should have applied.)
  left join lateral (
    select r.rate from public.fx_rates r
     where r.user_id = t.user_id and r.currency = t.currency
       and r.month <= to_char(t.posted_at at time zone 'America/Costa_Rica', 'YYYY-MM')
     order by r.month desc limit 1
  ) recent on true
  left join lateral (
    select r.rate from public.fx_rates r
     where r.user_id = t.user_id and r.currency = a.default_currency
       and r.month <= to_char(t.posted_at at time zone 'America/Costa_Rica', 'YYYY-MM')
     order by r.month desc limit 1
  ) recent2 on true

  cross join lateral (
    select case
      when t.currency = a.default_currency then t.amount

      -- A card is still settling: only its own month's rate will do, because
      -- folding in a stale one would misstate what is actually owed.
      when a.type = 'card' and a.default_currency = 'CRC' then t.amount * fx.rate
      when a.type = 'card' and t.currency = 'CRC' then t.amount / nullif(fx2.rate, 0)

      -- Anything else has already been converted by the bank and spent. The
      -- month's rate if it is set, otherwise the most recent one: approximate
      -- beats a balance that is silently too high.
      when a.default_currency = 'CRC' then t.amount * coalesce(fx.rate, recent.rate)
      when t.currency = 'CRC' then t.amount / nullif(coalesce(fx2.rate, recent2.rate), 0)

      else null
    end as amount
  ) conv

  where (s.as_of is null or t.posted_at::date > s.as_of)
  group by a.id
)
select
  a.id   as account_id,
  a.user_id,
  a.label,
  a.type,
  a.default_currency as currency,
  s.as_of   as snapshot_date,
  s.balance as snapshot_balance,
  coalesce(s.balance, 0) + coalesce(m.moved, 0) as current_balance,
  s.as_of is not null as has_snapshot,
  case when s.as_of is null then null
       else s.as_of < (current_date - interval '30 days')
  end as snapshot_stale,
  a.scope,
  coalesce(m.pending_fx, 0) as pending_fx
from public.accounts a
left join last_snap s on s.account_id = a.id
left join movement m on m.account_id = a.id
where a.active;

alter view public.account_balances set (security_invoker = on);
grant select on public.account_balances to authenticated;
