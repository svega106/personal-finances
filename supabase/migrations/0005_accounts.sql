-- 0005 — savings balances, and the view that reports them.
--
-- Idempotent, like every migration here: safe to run twice.

-- ---------------------------------------------------------------- security
--
-- A view created by `postgres` runs as its owner, so row-level security on
-- the tables underneath it does NOT apply: any signed-in user could read
-- every user's balances through it. `security_invoker` makes the view run as
-- the caller instead, which is what puts RLS back in force.
--
-- This matters the moment a second user exists; fixing it now costs nothing.
-- The view also needs to say whether an account is personal or work: work
-- charges are money that comes back, so they must stay out of the personal
-- totals. `create or replace view` allows appending a column at the end.
create or replace view public.account_balances as
with last_snap as (
  select distinct on (account_id)
         account_id, user_id, as_of, balance, currency
  from public.balance_snapshots
  order by account_id, as_of desc
)
select
  a.id   as account_id,
  a.user_id,
  a.label,
  a.type,
  a.default_currency as currency,
  s.as_of   as snapshot_date,
  s.balance as snapshot_balance,
  coalesce(s.balance, 0) + coalesce((
    select sum(
      case
        when t.kind = 'income'                                then  t.amount
        when t.kind = 'adjustment'                            then  t.amount
        when t.kind = 'transfer'
             and t.counterparty_account_id = a.id             then  t.amount
        when t.kind = 'transfer' and t.account_id = a.id      then -t.amount
        when t.kind = 'expense'                               then -t.amount
        else 0
      end)
    from public.transactions t
    where t.user_id = a.user_id
      and t.status <> 'voided'
      and t.currency = a.default_currency
      and (t.account_id = a.id or t.counterparty_account_id = a.id)
      and (s.as_of is null or t.posted_at::date > s.as_of)
  ), 0) as current_balance,
  s.as_of is not null as has_snapshot,
  case when s.as_of is null then null
       else s.as_of < (current_date - interval '30 days')
  end as snapshot_stale,
  a.scope
from public.accounts a
left join last_snap s on s.account_id = a.id
where a.active;

alter view public.account_balances set (security_invoker = on);

grant select on public.account_balances to authenticated;

-- ------------------------------------------------------- savings account names
--
-- 0002 already seeded the savings accounts as "Ahorros CRC" and "Ahorros USD";
-- this does NOT create them again. It only brings their names into line with
-- the ₡ / $ convention 0004 gave the cards, so every account in the list
-- says which currency it settles in the same way.
--
-- Renaming in place keeps their ids, so existing snapshots still point at them.

create or replace function public.rename_savings_accounts(p_user_id uuid default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := p_user_id;
  n_users int;
  n int;
begin
  if uid is null then uid := auth.uid(); end if;
  if uid is null then
    select count(*) into n_users from auth.users;
    if n_users = 1 then select id into uid from auth.users;
    elsif n_users = 0 then raise exception 'No users yet.';
    else raise exception '% users exist. Pass one.', n_users;
    end if;
  end if;

  update public.accounts a
     set label = v.new_label
    from (values
      ('Ahorros CRC', 'Ahorros ₡'),
      ('Ahorros USD', 'Ahorros $')
    ) as v(old_label, new_label)
   where a.user_id = uid
     and a.label = v.old_label;

  get diagnostics n = row_count;
  return format('renamed %s savings accounts for user %s', n, uid);
end $$;

revoke all on function public.rename_savings_accounts(uuid) from public;
grant execute on function public.rename_savings_accounts(uuid) to authenticated;
