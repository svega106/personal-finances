-- 0011 — a transfer between currencies records both amounts.
--
-- Paying a dollar card from a colón account takes one figure out of savings
-- and takes a different one off the card: the bank converts at its own rate
-- that day. Until now the row held only what left savings, and the balance
-- view converted it for the card at the month's rate — close, never exact,
-- and nothing at all until that rate was entered.
--
-- `counterparty_amount` is what arrived, in the counterparty account's own
-- currency. It is set only when the two currencies differ; a same-currency
-- transfer moves one amount and leaves it null, exactly as before.
--
-- The view is 0008's with one case added ahead of every conversion: the
-- counterparty side of a transfer that carries its own amount uses it as is.
--
-- Idempotent: adds the column and constraint once, replaces the view.

alter table public.transactions
  add column if not exists counterparty_amount numeric(14,2);

do $$ begin
  alter table public.transactions add constraint tx_counterparty_amount_ck
    check (counterparty_amount is null
           or (kind = 'transfer' and counterparty_account_id is not null and counterparty_amount > 0));
exception when duplicate_object then null; end $$;

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
