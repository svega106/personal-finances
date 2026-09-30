-- 0012 — a notification for each new charge, and which kinds each device gets.
--
-- A device that has notifications on now receives two kinds: the cutoff
-- reminders (0010), and each new card charge as the sync brings it in. A
-- phone may want both and a laptop neither, so the choice is per device, on
-- its own subscription row. Both start on: a device switched on before this
-- was switched on for reminders, and new-charge alerts are why it is here.
--
-- The index is for the app's once-a-minute question while it is open — "has
-- the ledger changed?" — answered from the newest updated_at and a count.
--
-- Idempotent: safe to run twice.

alter table public.push_subscriptions
  add column if not exists notify_charges boolean not null default true,
  add column if not exists notify_cutoffs boolean not null default true;

create index if not exists tx_user_updated_idx
  on public.transactions (user_id, updated_at desc);
