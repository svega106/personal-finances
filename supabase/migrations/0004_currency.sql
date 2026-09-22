-- Model each card's colón and dollar balances as separate accounts, and stop
-- pretending a foreign charge has a colón value on the day it happens.
--
-- A Costa Rican credit card carries two balances, billed and paid separately.
-- Converting a USD charge at transaction time invents a number: nothing is
-- actually converted until the statement is paid, at whatever rate applies
-- then. So a foreign charge now stores only its own currency, and its colón
-- value is derived from a rate entered once per month.
--
-- Run after 0003_goals.sql. Safe to re-run.

-- ---------------------------------------------- one account per currency

-- The old index allowed only one row per (issuer, last4), which blocks the
-- colón and dollar halves of the same card from coexisting.
drop index if exists public.accounts_issuer_last4_uq;

create unique index if not exists accounts_issuer_last4_currency_uq
  on public.accounts (user_id, issuer, last4, default_currency)
  where last4 is not null;

-- --------------------------------------------- amount_crc becomes derived

-- Null for a foreign charge until the month's rate is known. For a colón
-- charge it stays equal to `amount`.
alter table public.transactions alter column amount_crc drop not null;

-- The old rule demanded an fx_rate on every foreign charge. That rate does
-- not exist yet at import time.
alter table public.transactions drop constraint if exists tx_fx_ck;

-- Keep the weaker guarantee that still holds: a colón charge is its own
-- colón value, and carries no rate.
alter table public.transactions drop constraint if exists tx_crc_ck;
alter table public.transactions add constraint tx_crc_ck check (
  currency <> 'CRC' or (fx_rate is null and (amount_crc is null or amount_crc = amount))
);

-- ------------------------------------------------------ monthly fx rates

-- One rate per currency per month: what that month's foreign balance was
-- actually settled at. Entered when the statement is paid.
create table if not exists public.fx_rates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  month       text not null,                  -- 'YYYY-MM'
  currency    text not null,                  -- the foreign currency
  rate        numeric(12,4) not null,         -- CRC per 1 unit
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint fx_rates_uq       unique (user_id, month, currency),
  constraint fx_rates_month_ck check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  constraint fx_rates_cur_ck   check (currency <> 'CRC'),
  constraint fx_rates_rate_ck  check (rate > 0)
);

do $$ begin
  create trigger fx_rates_touch before update on public.fx_rates
    for each row execute function public.touch_updated_at();
exception when duplicate_object then null;
end $$;

alter table public.fx_rates enable row level security;

do $$ begin
  create policy fx_rates_owner on public.fx_rates for all
    to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));
exception when duplicate_object then null;
end $$;

-- --------------------------------------------------- reseed the accounts

-- Replaces seed_defaults()'s account list with one row per card per currency.
-- Existing rows are matched on (issuer, last4, currency) and left alone.
create or replace function public.seed_currency_accounts(p_user_id uuid default null)
returns text
language plpgsql
security invoker
as $$
declare
  uid uuid;
  n_users int;
  n int;
begin
  uid := coalesce(p_user_id, auth.uid());
  if uid is null then
    select count(*) into n_users from auth.users;
    if n_users = 1 then select id into uid from auth.users;
    elsif n_users = 0 then raise exception 'No users yet.';
    else raise exception '% users exist. Pass one.', n_users;
    end if;
  end if;

  -- The rows seeded by 0002 are already the colón accounts. Rename them in
  -- place rather than inserting duplicates — transactions may point at them.
  update public.accounts a
     set label = v.label, sort_order = v.sort_order
    from (values
      ('bac','4477','BAC VISA ₡',        10),
      ('bac','9654','BAC AMEX ₡',        20),
      ('davivienda','5131','Davivienda ₡',30),
      ('promerica','1763','Promerica ₡',  40),
      ('bncr','0828','BNCR VISA ₡ (work)',50)
    ) as v(issuer, last4, label, sort_order)
   where a.user_id = uid
     and a.issuer = v.issuer
     and a.last4 = v.last4
     and a.default_currency = 'CRC';

  -- Then add the dollar half of each card.
  insert into public.accounts
    (user_id, label, type, issuer, institution, brand, last4, default_currency, scope, sort_order)
  values
    (uid, 'BAC VISA $',        'card', 'bac',        'BAC Credomatic', 'visa', '4477', 'USD', 'personal', 11),
    (uid, 'BAC AMEX $',        'card', 'bac',        'BAC Credomatic', 'amex', '9654', 'USD', 'personal', 21),
    (uid, 'Davivienda $',      'card', 'davivienda', 'Davivienda',     'visa', '5131', 'USD', 'personal', 31),
    (uid, 'Promerica $',       'card', 'promerica',  'Banco Promerica', null,  '1763', 'USD', 'personal', 41),
    (uid, 'BNCR VISA $ (work)','card', 'bncr',       'Banco Nacional', 'visa', '0828', 'USD', 'work',     51)
  on conflict do nothing;

  get diagnostics n = row_count;

  return format('added %s currency-split accounts for user %s', n, uid);
end $$;
