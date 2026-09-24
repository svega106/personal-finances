-- 0009 — put the card numbers back, and make losing them impossible.
--
-- The account edit sheet rendered the card fields only for savings and cash
-- accounts: for a card, the number is the account's own identity, so the block
-- was left out. The save path still read those inputs, got empty strings back
-- because they were not on the page, and wrote issuer and last4 as null. So
-- every card that was renamed quietly lost the number the email sync matches
-- on, and from then on no charge could be attached to any account.
--
-- Three things here: give the cards their numbers back, attach the charges
-- that arrived while they had none, and add a constraint so a card row can
-- never again exist without a number.
--
-- Idempotent: re-running changes nothing.

-- ------------------------------------------------------ 1. the cards
--
-- Where an account still has charges from before the numbers were lost, the
-- history says what its card was — no guessing needed. This runs first and
-- covers every account that was ever matched to.

update public.accounts a
   set issuer = d.issuer,
       last4  = d.last4
  from (
    select t.account_id,
           split_part(t.ext_id, ':', 1) as issuer,
           split_part(t.ext_id, ':', 2) as last4,
           count(*)                     as n
      from public.transactions t
     where t.source = 'email'
       and t.account_id is not null
       and t.ext_id like '%:%:%'
     group by 1, 2, 3
  ) d
 where d.account_id = a.id
   and a.type = 'card'
   and a.issuer is null
   -- Only when that account's whole history agrees on one card.
   and not exists (
     select 1 from public.transactions t2
      where t2.account_id = a.id and t2.source = 'email'
        and split_part(t2.ext_id, ':', 2) <> d.last4
   );

-- The dollar half of a card usually has no history of its own — dollar
-- charges wait for a rate and many were never assigned. It is the same
-- physical card as the colón half, so it takes the same number, paired by the
-- name they still share.
--
-- 'BAC Dorada Colones' and 'BAC Dorada Dolares' differ only in that last word,
-- so the pairing is on everything before it.

update public.accounts a
   set issuer = twin.issuer,
       brand  = coalesce(a.brand, twin.brand),
       last4  = twin.last4
  from public.accounts twin
 where twin.user_id = a.user_id
   and twin.type = 'card'
   and twin.issuer is not null
   and a.type = 'card'
   and a.issuer is null
   and a.id <> twin.id
   and a.default_currency <> twin.default_currency
   and regexp_replace(a.label,    '\s*(Colones|Dolares|Dólares|₡|\$)\s*', ' ', 'gi')
     = regexp_replace(twin.label, '\s*(Colones|Dolares|Dólares|₡|\$)\s*', ' ', 'gi');

-- Anything the two passes above could not recover has no history and no twin
-- with history. Rather than guess a card number, say which account it is.
do $$
declare
  orphan text;
begin
  select string_agg(label, ', ' order by label)
    into orphan
    from public.accounts
   where type = 'card' and active and (issuer is null or last4 is null);

  if orphan is not null then
    raise exception
      'These card accounts have no number and none could be recovered: %. '
      'Set them on the Accounts tab (Edit → Card) and run this again.', orphan;
  end if;
end $$;

-- Brand is cosmetic — the sync never reads it — but an AMEX row saying it is a
-- VISA would be its own small lie.
update public.accounts
   set brand = case
                 when lower(label) like '%amex%' then 'amex'
                 when lower(label) like '%visa%' then 'visa'
                 when lower(label) like '%master%' then 'mastercard'
                 else brand
               end
 where type = 'card' and brand is null;


-- --------------------------------------- 2. the charges left unattached
--
-- Same rule the sync itself applies, and in the same order. An exact match on
-- issuer, last four and currency first.

update public.transactions t
   set account_id = a.id
  from public.accounts a
 where a.user_id = t.user_id
   and a.active
   and t.account_id is null
   and t.source = 'email'
   and a.issuer = split_part(t.ext_id, ':', 1)
   and a.last4  = split_part(t.ext_id, ':', 2)
   and a.default_currency = t.currency;

-- Then the debit-card case: the currency does not match because the card is
-- not split, only the notification speaks dollars. Fall back to the card
-- alone, and only when exactly one account carries it — two candidates means
-- the card really is currency-split and guessing which half is worse than
-- leaving the charge alone.

update public.transactions t
   set account_id = u.id
  from (
    select user_id, issuer, last4, (array_agg(id))[1] as id, count(*) as n
      from public.accounts
     where active and issuer is not null and last4 is not null
     group by user_id, issuer, last4
  ) u
 where u.user_id = t.user_id
   and u.n = 1
   and t.account_id is null
   and t.source = 'email'
   and u.issuer = split_part(t.ext_id, ':', 1)
   and u.last4  = split_part(t.ext_id, ':', 2);


-- ------------------------------------------- 3. what those charges claim
--
-- A work charge with no account was recorded as money awaiting reimbursement,
-- because the rule for "the company paid this directly" reads the scope of the
-- card it is on and there was no card to read. Now that the BNCR charges are
-- back on the work card, they are the company's to settle and were never owed.

update public.transactions t
   set reimbursement = null
  from public.accounts a
 where a.id = t.account_id
   and a.scope = 'work'
   and t.scope = 'work'
   and t.reimbursement is not null;

-- And the opposite: work spending on a personal card is out of pocket until
-- it comes back, so it starts as pending.

update public.transactions t
   set reimbursement = jsonb_build_object('status', 'pending')
  from public.accounts a
 where a.id = t.account_id
   and a.scope <> 'work'
   and t.scope = 'work'
   and t.reimbursement is null;


-- ------------------------------------------------- 4. never again
--
-- The UI bug is fixed, but a card account with no number is nonsense in any
-- case: nothing can ever be matched to it. The database should say so.

alter table public.accounts
  drop constraint if exists accounts_card_needs_number;

alter table public.accounts
  add constraint accounts_card_needs_number
  check (type <> 'card' or (issuer is not null and last4 is not null));
