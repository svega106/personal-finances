-- 0015 — a balance can never be dated ahead of when it was entered.
--
-- Ahorros Colones was saved "as of" Oct 1 at 10:36pm on Sep 30. A balance
-- dated a day other than the one it is entered on stands for the end of that
-- day — the rule for backdating ("what it held at the end of Sep 28"). Dated
-- ahead, the same rule read as "everything up to the end of Oct 1 is already
-- in this figure", so nothing entered on Oct 1 moved the balance.
--
-- Now a balance dated ahead is read as of the day it was entered: it stands
-- for that moment, and what comes after counts on top. Among several, the
-- latest day wins and, on the same day, the one entered last. No row is
-- changed; the app also stops offering a date after today.
--
-- The view is 0013's with only the choice of balance changed.
--
-- Idempotent: replaces the view.

create or replace view public.account_balances as
with snap as (
  -- A balance cannot stand for a day that had not happened when it was
  -- entered. Dated ahead, it is read as of the day it was entered.
  select account_id, user_id, balance, currency, recorded_at,
         least(as_of, (recorded_at at time zone 'America/Costa_Rica')::date) as as_of
  from public.balance_snapshots
),
last_snap as (
  select distinct on (account_id)
         account_id, user_id, as_of, balance, currency,
         -- The instant the balance stands for. Entered on the day it is
         -- dated, it is that moment; dated an earlier day, the end of that
         -- day in Costa Rica. Anything after the cut counts on top of it.
         case
           when as_of = (recorded_at at time zone 'America/Costa_Rica')::date then recorded_at
           else (as_of + 1)::timestamp at time zone 'America/Costa_Rica'
         end as cut
  from snap
  -- The latest day wins; on the same day, the one entered last.
  order by account_id, as_of desc, recorded_at desc
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
      -- What reached this account, as the bank stated it: no rate involved.
      when t.kind = 'transfer' and t.counterparty_account_id = a.id
           and t.counterparty_amount is not null then t.counterparty_amount

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

  where (s.cut is null or t.posted_at > s.cut)
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
  coalesce(m.pending_fx, 0) as pending_fx,
  s.cut as snapshot_cut
from public.accounts a
left join last_snap s on s.account_id = a.id
left join movement m on m.account_id = a.id
where a.active;

alter view public.account_balances set (security_invoker = on);
grant select on public.account_balances to authenticated;
