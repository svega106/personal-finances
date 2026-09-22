# Supabase setup

## 1. Create the project

New project at supabase.com. Region **East US (North Virginia)** — closest
free option to Costa Rica. Save the database password somewhere safe; it is
shown once.

## 2. Apply the schema

SQL Editor → paste `migrations/0001_init.sql` → Run.

Creates `accounts`, `rules`, `transactions`, `budgets`, `balance_snapshots`,
`settings`, the `account_balances` view, and row-level security on everything.

## 3. Create your user

Every row is owned by a user, so one has to exist before seeding. There is no
app to sign in to yet, so create it by hand:

**Authentication → Users → Add user → Create new user.** Use your Gmail
address and any password. Tick "Auto Confirm User".

Note the UUID it shows in the user list — you probably will not need it, but
step 4 mentions it.

## 4. Seed

SQL Editor → paste `migrations/0002_seed.sql` → Run. Then:

```sql
select public.seed_defaults();
```

Inserts the 5 cards, cash, the two savings accounts, and 37 starter rules.
Safe to re-run — it skips anything already there.

With exactly one user this needs no argument. If more than one user exists it
will refuse and ask you to name one:

```sql
select public.seed_defaults('<user-uuid>');
```

> `auth.uid()` is null in the SQL Editor, which runs unauthenticated. That is
> why the function falls back to "the only user" rather than requiring a
> session.

## 5. Google sign-in

Only needed once the app exists, but it can be configured now.

Authentication → Providers → Google. The Client ID and Secret come from an
OAuth client created at
[console.cloud.google.com/auth/clients](https://console.cloud.google.com/auth/clients)
(type: Web application):

| Google field | Value |
| --- | --- |
| Authorized JavaScript origins | `http://localhost:5173`, later the Pages URL |
| Authorized redirect URIs | The callback URL on the Supabase Google provider page |

Set the Google app's publishing status to **In production**. Sign-in uses only
the basic email/profile scopes, so no review is needed, and apps left in
Testing expire tokens every 7 days.

If signing in with Google later creates a *second* user rather than attaching
to the one from step 3, repoint the seeded rows — harmless while there is no
real data:

```sql
update public.accounts set user_id = '<google-user-uuid>' where user_id = '<old-uuid>';
update public.rules    set user_id = '<google-user-uuid>' where user_id = '<old-uuid>';
update public.settings set user_id = '<google-user-uuid>' where user_id = '<old-uuid>';
```

## 6. Keys

Settings → API. Two values:

| Key | Goes in | Never in |
| --- | --- | --- |
| Project URL + `anon` key | The frontend | — |
| `service_role` key | Worker secrets only | Frontend, git |

The anon key is public by design; RLS is what protects the data.

## Notes

- `amount` is positive for expense/income/transfer. Adjustments may be signed.
- Transfers carry both `account_id` (from) and `counterparty_account_id` (to),
  and are barred by a constraint from having a budget category — they are
  movements, not spending.
- `account_balances` computes balance as *last snapshot + movements after it*,
  in the account's own currency, ignoring voided rows. `has_snapshot` is false
  for an account never snapshotted; its balance is movements only.
- Free projects pause after a week idle. The daily sync prevents that.
