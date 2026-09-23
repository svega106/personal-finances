-- 0006 — charges on the company's own card are not awaiting reimbursement.
--
-- The BNCR card is paid by the company directly, so money spent on it never
-- leaves Sebas's pocket and there is nothing to claim back. Work expenses put
-- on a personal card are the opposite, and those are the ones worth chasing.
--
-- Everything ingested before this distinction existed was written as
-- `{"status": "pending"}` regardless of the card, which buried the handful
-- that genuinely owed him money under a list of charges that never would.
--
-- The app derives this from the account rather than trusting the stored flag,
-- so this migration is about the data not contradicting what is displayed.
-- Idempotent: re-running changes nothing once the rows are clean.

update public.transactions t
   set reimbursement = null
  from public.accounts a
 where a.id = t.account_id
   and a.user_id = t.user_id
   and a.scope = 'work'          -- the company's card
   and t.reimbursement is not null;

-- A charge marked `work` by hand on a personal card, with no reimbursement
-- recorded, is money still owed. Anything ingested before this had the flag
-- set already, so this only catches rows edited in the gap.
update public.transactions t
   set reimbursement = jsonb_build_object('status', 'pending')
 where t.scope = 'work'
   and t.reimbursement is null
   and (
     t.account_id is null
     or exists (
       select 1 from public.accounts a
        where a.id = t.account_id and a.user_id = t.user_id and a.scope <> 'work'
     )
   );
