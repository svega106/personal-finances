-- 0007 — the debit card on the colón savings account.
--
-- BAC Mastercard ****2207 is not an account of its own. It spends directly
-- from Ahorros ₡, so a charge on it should come off that balance rather than
-- appear as a card balance owed — which is what would have happened had it
-- been added as a card like the others.
--
-- Nothing new is created: the card is recorded *on* the savings account. The
-- `account_balances` view already subtracts every transaction pointing at an
-- account from its last snapshot, so this is all that is needed for the
-- arithmetic to come out right.
--
-- The dollar savings account has no card and is left alone.
--
-- Idempotent: re-running changes nothing.

update public.accounts
   set issuer = 'bac',
       brand  = 'mastercard',
       last4  = '2207'
 where label = 'Ahorros ₡'
   and default_currency = 'CRC'
   and (issuer is distinct from 'bac' or last4 is distinct from '2207');

-- Charges that already arrived before the card was known were stored with no
-- account. Attach them, so the savings balance reflects them.
update public.transactions t
   set account_id = a.id
  from public.accounts a
 where a.user_id = t.user_id
   and a.issuer = 'bac'
   and a.last4 = '2207'
   and t.account_id is null
   and t.source = 'email'
   and t.ext_id like 'bac:2207:%';


-- ------------------------------------------- foreign charges on a local card
--
-- The balance view only ever counted transactions whose currency matched the
-- account's own. For the credit cards that is right: each is split into a
-- colón half and a dollar half that are settled separately.
--
-- A debit card is not split. A dollar purchase on this colón card is debited
-- from the colón balance at the bank's rate — only the notification speaks
-- dollars. Counting it against nothing left the balance overstated.
--
-- Converted with the month's rate, the same one the app applies everywhere
-- else. Where no rate has been set the charge is left out rather than guessed
-- at, and `pending_fx` counts those so the app can say so instead of quietly
-- reporting a balance that is too high.

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
  -- The rate for the charge's own currency, and for the account's, in the
  -- month the charge was made. Joined before the lateral below, which reads
  -- them.
  left join public.fx_rates fx
    on fx.user_id = t.user_id
   and fx.month = to_char(t.posted_at at time zone 'America/Costa_Rica', 'YYYY-MM')
   and fx.currency = t.currency
  left join public.fx_rates fx2
    on fx2.user_id = t.user_id
   and fx2.month = to_char(t.posted_at at time zone 'America/Costa_Rica', 'YYYY-MM')
   and fx2.currency = a.default_currency
  cross join lateral (
    select case
      -- Same currency: nothing to convert.
      when t.currency = a.default_currency then t.amount
      -- Into colones, at the month's rate for the charge's currency.
      when a.default_currency = 'CRC' then t.amount * fx.rate
      -- Out of colones, the same rate the other way.
      when t.currency = 'CRC' then t.amount / nullif(fx2.rate, 0)
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
