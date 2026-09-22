-- Personal finance app — initial schema
-- Run once against a fresh Supabase project (SQL Editor, or `supabase db push`).
--
-- Conventions
--   * Money is numeric(14,2). Never float.
--   * `amount` is the original amount in `currency`; `amount_crc` is the
--     normalized value every total is computed from.
--   * `amount` is positive for expense / income / transfer.
--     Adjustments may be negative (a fee) or positive (interest posted).
--   * Every table is scoped by user_id and protected by RLS.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- accounts

create table public.accounts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users on delete cascade,
  label             text not null,                -- "BAC VISA", "Ahorros CRC"
  type              text not null default 'card', -- card | cash | savings | investment
  issuer            text,                         -- bac | davivienda | promerica | bncr
  institution       text,
  brand             text,                         -- visa | amex
  last4             text,
  default_currency  text not null default 'CRC',
  scope             text not null default 'personal', -- personal | work
  active            boolean not null default true,
  sort_order        int not null default 0,
  created_at        timestamptz not null default now(),

  constraint accounts_type_ck     check (type in ('card','cash','savings','investment')),
  constraint accounts_scope_ck    check (scope in ('personal','work')),
  constraint accounts_currency_ck check (default_currency in ('CRC','USD')),
  constraint accounts_last4_ck    check (last4 is null or last4 ~ '^[0-9]{4}$')
);

create unique index accounts_issuer_last4_uq
  on public.accounts (user_id, issuer, last4)
  where last4 is not null;

-- ------------------------------------------------------------------- rules

create table public.rules (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  pattern         text not null,
  match_type      text not null default 'contains', -- contains | exact | regex
  priority        int  not null default 100,        -- lower wins
  cat             text,                             -- needs | wants | savings
  budget_line_id  text,
  scope           text,                             -- overrides the account default
  merchant_clean  text,                             -- display name
  created_at      timestamptz not null default now(),

  constraint rules_match_ck check (match_type in ('contains','exact','regex')),
  constraint rules_cat_ck   check (cat is null or cat in ('needs','wants','savings')),
  constraint rules_scope_ck check (scope is null or scope in ('personal','work'))
);

create index rules_lookup_idx on public.rules (user_id, priority);

-- ------------------------------------------------------------ transactions

create table public.transactions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users on delete cascade,
  ext_id                  text not null,   -- {issuer}:{last4}:{auth}:{ref} | manual:{uuid}

  kind                    text not null default 'expense', -- expense | income | transfer | adjustment
  posted_at               timestamptz not null,

  merchant_raw            text,
  merchant                text,

  amount                  numeric(14,2) not null,
  currency                text not null default 'CRC',
  amount_crc              numeric(14,2) not null,
  fx_rate                 numeric(12,4),   -- null when currency = CRC

  account_id              uuid references public.accounts on delete restrict,
  counterparty_account_id uuid references public.accounts on delete restrict,

  scope                   text not null default 'personal',
  reimbursement           jsonb,           -- {status, submitted_at, paid_at}

  cat                     text,            -- needs | wants | savings
  budget_line_id          text,            -- -> a plan line's uid(); null = unbudgeted

  source                  text not null default 'manual',  -- email | manual
  method                  text not null default 'card',    -- card | cash | sinpe | transfer
  status                  text not null default 'pending', -- pending | settled | voided
  reviewed                boolean not null default false,

  auth_code               text,
  reference               text,
  mcc                     text,            -- Promerica "Tipo de Comercio"
  note                    text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint tx_ext_uq        unique (user_id, ext_id),
  constraint tx_kind_ck       check (kind in ('expense','income','transfer','adjustment')),
  constraint tx_currency_ck   check (currency in ('CRC','USD')),
  constraint tx_scope_ck      check (scope in ('personal','work')),
  constraint tx_cat_ck        check (cat is null or cat in ('needs','wants','savings')),
  constraint tx_source_ck     check (source in ('email','manual')),
  constraint tx_method_ck     check (method in ('card','cash','sinpe','transfer')),
  constraint tx_status_ck     check (status in ('pending','settled','voided')),
  constraint tx_fx_ck         check ((currency = 'CRC' and fx_rate is null)
                                  or (currency <> 'CRC' and fx_rate is not null)),
  -- only adjustments may be signed
  constraint tx_amount_ck     check (kind = 'adjustment' or amount > 0),
  -- a transfer needs both ends, and they must differ
  constraint tx_transfer_ck   check (kind <> 'transfer'
                                  or (counterparty_account_id is not null
                                      and counterparty_account_id <> account_id)),
  -- transfers are movements, not spending: they carry no budget category
  constraint tx_transfer_cat_ck check (kind <> 'transfer' or (cat is null and budget_line_id is null))
);

create index tx_month_idx    on public.transactions (user_id, posted_at desc);
create index tx_account_idx  on public.transactions (user_id, account_id, posted_at desc);
create index tx_review_idx   on public.transactions (user_id, reviewed) where reviewed = false;
create index tx_budget_idx   on public.transactions (user_id, budget_line_id)
  where budget_line_id is not null;

-- ----------------------------------------------------------------- budgets

-- The monthly plan, stored whole. Mirrors the current localStorage month object:
-- { income, extraIncome[], bills[], recurring[], oneTime[], contributions{}, invest, usedCarryover }
create table public.budgets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  month       text not null,                 -- 'YYYY-MM'
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint budgets_month_uq unique (user_id, month),
  constraint budgets_month_ck check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

-- ------------------------------------------------------- balance snapshots

create table public.balance_snapshots (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  account_id  uuid not null references public.accounts on delete cascade,
  as_of       date not null,
  balance     numeric(14,2) not null,
  currency    text not null default 'CRC',
  note        text,
  created_at  timestamptz not null default now(),

  constraint snap_uq          unique (user_id, account_id, as_of),
  constraint snap_currency_ck check (currency in ('CRC','USD'))
);

create index snap_account_idx on public.balance_snapshots (user_id, account_id, as_of desc);

-- ------------------------------------------------- app settings (singleton)

create table public.settings (
  user_id     uuid primary key references auth.users on delete cascade,
  data        jsonb not null default '{"alloc":{"needs":50,"wants":30,"savings":20}}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------ updated_at

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger transactions_touch before update on public.transactions
  for each row execute function public.touch_updated_at();
create trigger budgets_touch      before update on public.budgets
  for each row execute function public.touch_updated_at();
create trigger settings_touch     before update on public.settings
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------- current balance

-- Balance = most recent snapshot + movements dated after it.
-- Computed in the account's own currency; movements in another currency are
-- ignored here rather than silently converted. Voided rows never count.
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
  -- null when the account has never been snapshotted: "unknown", not "fresh"
  case when s.as_of is null then null
       else s.as_of < (current_date - interval '30 days')
  end as snapshot_stale
from public.accounts a
left join last_snap s on s.account_id = a.id
where a.active;

-- --------------------------------------------------------------------- RLS

alter table public.accounts          enable row level security;
alter table public.rules             enable row level security;
alter table public.transactions      enable row level security;
alter table public.budgets           enable row level security;
alter table public.balance_snapshots enable row level security;
alter table public.settings          enable row level security;

do $$
declare t text;
begin
  foreach t in array array['accounts','rules','transactions','budgets','balance_snapshots','settings']
  loop
    execute format(
      'create policy %I_owner on public.%I for all
         to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))', t, t);
  end loop;
end $$;
