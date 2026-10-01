-- 0014 — transaction types you define.
--
-- `transactions.scope` said personal or work. It now holds a type key from
-- your own list, kept in settings: Personal and Work are built in, and more
-- can be added in the app's Settings → Transaction types — a shared expense,
-- a loan to someone, medical the insurer pays back. Each type says whether
-- it counts as spending and whether its charges are money owed back; a
-- transaction carries only the key, so renaming a type renames it everywhere.
--
-- Only the check changes. Existing rows are all 'personal' or 'work' and stay
-- as they are. Accounts and rules keep personal | work: a card is yours or
-- the company's, and that is not a type.
--
-- Idempotent: safe to run twice.

alter table public.transactions drop constraint if exists tx_scope_ck;
alter table public.transactions add constraint tx_scope_ck
  check (scope ~ '^[a-z][a-z0-9-]{0,39}$');
