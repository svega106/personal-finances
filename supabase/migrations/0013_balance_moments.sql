-- 0013 — a recorded balance is a moment, and manual entries keep theirs.
--
-- Two faults, reported together: a manual entry showed 12:00 pm whatever time
-- it was entered, and an expense on Ahorros ₡ did not move its balance.
--
-- They were one fault seen twice. The app stamped every manual entry at noon.
-- And account_balances added a transaction on top of the last recorded
-- balance only when it was dated after that balance's DAY — read in UTC, at
-- that. So with a balance recorded at 3pm and an expense entered at 4pm the
-- same day, the expense said noon, its day was not after the balance's day,
-- and the balance never moved. An evening charge, meanwhile, is already the
-- next day in UTC, so it did count: the rule was inconsistent as well.
--
-- Now:
--
--   - balance_snapshots.recorded_at is when the figure was entered, set by a
--     trigger on every save. A balance dated the day it was entered stands
--     for that moment: what came after counts on top, what came before is
--     already in it. A backdated one stands for the end of its day, in Costa
--     Rica time. The view exposes that instant as snapshot_cut.
--   - Manual entries stamped at noon on the day they were entered get the
--     moment they were actually entered (created_at). One dated another day
--     keeps noon: when on that day it happened was never recorded.
--
-- The app stamps a manual entry with the moment it is made, and asks for the
-- time when that is not now.
--
-- The view is 0011's with the cut in place of the day comparison, and
-- snapshot_cut added at the end.
--
-- Idempotent: safe to run twice.

-- ------------------------------------------------ when a balance was entered

alter table public.balance_snapshots add column if not exists recorded_at timestamptz;

-- Rows from before this: the closest record of when is when they were added.
update public.balance_snapshots set recorded_at = created_at where recorded_at is null;

alter table public.balance_snapshots
  alter column recorded_at set default now(),
  alter column recorded_at set not null;

-- On every save, insert or correction: re-entering today's balance at 5pm
-- makes it stand for 5pm.
create or replace function public.balance_snapshot_recorded()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.recorded_at = now();
  return new;
end $$;

drop trigger if exists balance_snapshots_recorded on public.balance_snapshots;
create trigger balance_snapshots_recorded
  before insert or update on public.balance_snapshots
  for each row execute function public.balance_snapshot_recorded();

-- ------------------------------------- manual entries, back to their moment

update public.transactions
   set posted_at = created_at
 where source = 'manual'
   and (posted_at at time zone 'America/Costa_Rica')::time = time '12:00'
   and (posted_at at time zone 'America/Costa_Rica')::date
     = (created_at at time zone 'America/Costa_Rica')::date;

-- ---------------------------------------------------------------- the view

create or replace view public.account_balances as
with last_snap as (
  select distinct on (account_id)
         account_id, user_id, as_of, balance, currency,
         -- The instant the balance stands for. Entered on the day it is
         -- dated, it is that moment; dated another day, the end of that day
         -- in Costa Rica. Anything after the cut counts on top of it.
         case
           when as_of = (recorded_at at time zone 'America/Costa_Rica')::date then recorded_at
           else (as_of + 1)::timestamp at time zone 'America/Costa_Rica'
         end as cut
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
