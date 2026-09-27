-- 0010 — billing cutoffs on credit cards, and push reminders ahead of them.
--
-- Transfers and income need nothing here: `kind` has allowed 'transfer' and
-- 'income' since 0001, and `account_balances` already moves a transfer out
-- of `account_id` and into `counterparty_account_id`. One row is the whole
-- pair — writing a second would count it twice.
--
-- Idempotent, like every migration here: safe to run twice.

-- ------------------------------------------------------------ cutoffs
--
-- A day of the month, not a date: the cutoff recurs. 1–31 is allowed and a
-- short month clamps to its last day, so "day 31" means the last day of every
-- month rather than silently skipping February.
--
-- Stored on both halves of a card (the ₡ row and the $ row share one bill);
-- the app writes them together and reminds once per physical card.
--
-- Only a credit card has a bill. The debit card on Ahorros ₡ (0007) is
-- recorded on a savings row, so the last constraint keeps it from ever being
-- given a cutoff.

alter table public.accounts add column if not exists cutoff_day smallint;
alter table public.accounts add column if not exists cutoff_warn_days smallint not null default 3;

do $$ begin
  alter table public.accounts add constraint accounts_cutoff_day_ck
    check (cutoff_day is null or cutoff_day between 1 and 31);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.accounts add constraint accounts_cutoff_warn_ck
    check (cutoff_warn_days between 0 and 31);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.accounts add constraint accounts_cutoff_card_ck
    check (cutoff_day is null or type = 'card');
exception when duplicate_object then null;
end $$;

-- ------------------------------------------------- push subscriptions
--
-- One row per device that allowed notifications. The endpoint is the
-- device's address at its push service; the two keys encrypt what is sent.

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),

  constraint push_endpoint_uq unique (endpoint)
);

create index if not exists push_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

do $$ begin
  create policy push_subscriptions_owner on public.push_subscriptions for all
    to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));
exception when duplicate_object then null;
end $$;

-- ------------------------------------------------------ reminders sent
--
-- What makes the daily job safe to run twice, or to catch up after a day it
-- missed: a reminder is claimed here before it is sent, and the unique key
-- lets exactly one claim per card per billing cycle succeed.
--
-- Keyed on the card (issuer:last4), not an account id, because a card is two
-- account rows and the reminder is about the card.
--
-- Written only by the edge function, with the service role. The owner may
-- read it.

create table if not exists public.cutoff_reminders_sent (
  user_id     uuid not null references auth.users on delete cascade,
  card_key    text not null,
  cutoff_date date not null,
  sent_at     timestamptz not null default now(),

  primary key (user_id, card_key, cutoff_date)
);

alter table public.cutoff_reminders_sent enable row level security;

do $$ begin
  create policy cutoff_reminders_sent_read on public.cutoff_reminders_sent for select
    to authenticated
    using (user_id = (select auth.uid()));
exception when duplicate_object then null;
end $$;
