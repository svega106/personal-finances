-- Savings goals. Missed in 0001: the app has always had goals, and the spec
-- calls for linking one to a real savings account.
--
-- Run after 0001_init.sql. Safe to re-run.

create table if not exists public.goals (
  -- Text, not uuid: the app mints goal ids with its own uid() helper, and a
  -- month's `contributions` object is keyed by them. Changing the id format
  -- would orphan every existing contribution.
  id          text primary key default gen_random_uuid()::text,
  user_id     uuid not null references auth.users on delete cascade,

  name        text not null,
  target      numeric(14,2) not null default 0,
  saved       numeric(14,2) not null default 0,
  monthly     numeric(14,2),              -- suggested contribution, optional
  deadline    text,                       -- free text: "Dec 2026"

  -- When set, progress reads the real balance instead of `saved`.
  account_id  uuid references public.accounts on delete set null,

  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists goals_user_idx on public.goals (user_id, sort_order);

do $$ begin
  create trigger goals_touch before update on public.goals
    for each row execute function public.touch_updated_at();
exception when duplicate_object then null;
end $$;

alter table public.goals enable row level security;

do $$ begin
  create policy goals_owner on public.goals for all
    to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));
exception when duplicate_object then null;
end $$;
