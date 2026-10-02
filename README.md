# Personal Finances

A monthly budgeting app that tracks planned spending against what actually
happened, with card charges read from bank notification emails.

## Layout

| Folder | Holds |
| --- | --- |
| `app/` | The web app — Vite, vanilla JS, Supabase |
| `supabase/` | Database migrations, and the email ingest function |
| `sync/` | Tests for the parsers, and the Apps Script that fetches the mail |
| `tools/` | Test harnesses: smoke tests and screenshots |
| `finance-advisor.html` | The original single-file app, kept for reference |

## Getting it running

```
cd supabase        # follow README.md: create the project, run migrations
cd ../app
cp .env.example .env.local   # fill in Supabase URL + anon key
npm install
npm run dev                  # open /?demo for sample data without signing in
```

## Tests

```
cd app  && npm test   # persistence
cd sync && npm test   # email parsers, and the row they produce
```

The ingest function is an HTTP endpoint, so it is driven with real requests
against a stubbed database:

```
cd sync/edge-test && deno run --allow-net --allow-env --allow-read handler.test.ts
```

Without Deno installed, `npx -y deno run --node-modules-dir=none …` does the
same (the flag keeps it off the app's `node_modules`). web-push is stubbed as
well, so the test also covers the notification a new charge sends.

Browser-level checks live in `tools/` and need the app running:

```
node tools/smoke.mjs    http://localhost:4173/            # the five original views
node tools/tx-smoke.mjs http://localhost:4173/            # the transactions view
node tools/pwa-check.mjs http://localhost:4173/ app/dist  # install, offline, update
node tools/refresh-check.mjs http://localhost:4173/       # does the screen follow the data
node tools/evening-charge.mjs                            # a 9pm charge, end to end
```

`refresh-check.mjs` is the one that catches "I saved it and nothing happened".
Server data lives in four separate caches, and a write that drops only its own
leaves another view showing the figure it had before — every unit test passes,
the number on screen is stale. Only a browser sees that.

`pwa-check.mjs` needs the build directory as well as the URL: proving that an
update reaches an installed app means publishing one, so it edits the served
files and puts them back.


## Putting a wrong timestamp right

`repairDatesLast30Days()` in the Apps Script re-reads a month of bank mail and
corrects `posted_at` on charges that are already stored. It is the one path
allowed to write over an existing row, so it writes exactly one column,
matched on `ext_id`, and only where the value differs — a category, a renamed
merchant, a reimbursement or a corrected account is not in the update at all.
Safe to run twice; the second run reports everything as already correct.

It exists because the app's edit sheet once took a charge's date by slicing
the UTC timestamp and wrote it back as noon, so every charge reviewed by hand
lost the minute the bank recorded and the late ones moved a day forward. An
ordinary re-sync cannot fix that, because `ignoreDuplicates` is there to
protect the hand edits.

A repair never advances the watermark. The watermark says what has been
offered for import, and a repair imports nothing — moving it would step over
a charge in that window that had failed to import.

## How charges get in

```
Gmail ──▶ Apps Script ──▶ POST /functions/v1/ingest-email ──▶ Postgres
         (fetch only)      (parse, classify, write)
```

Apps Script only fetches and forwards. Every bank-specific rule lives in
`supabase/functions/_shared/parsers.js`, in this repo, under test — the same
module the browser uses, so a merchant is categorized identically whether you
typed it in or an email brought it in.

It runs inside the Google account rather than calling the Gmail API from a
server. A server needs an OAuth client, and Google expires refresh tokens
after 7 days while the consent screen sits in "Testing" — a cron job that dies
every week. Running as the account itself means no token to rotate and nothing
to verify.

### Setting it up

1. **Deploy the function.** In a terminal, in the repo root — the same place
   you run `git push`. The first two commands are one-time setup; only the
   third is repeated when the function changes.

   ```
   npx supabase login                                  # opens a browser
   npx supabase link --project-ref zemxydjuuugzumxjrpqf
   npx supabase functions deploy ingest-email --no-verify-jwt
   ```

   `link` writes `supabase/config.toml` and asks for the database password —
   the one set when the project was created, not the Supabase account
   password. It is only needed once.

   `--no-verify-jwt` is deliberate: the caller is a script, not a signed-in
   person, so there is no user JWT to check. The shared secret below is the
   authentication.

   On Windows, if PowerShell refuses with *"npx.ps1 cannot be loaded ... not
   digitally signed"*, use `npx.cmd` in place of `npx`, or allow local scripts
   once with:

   ```
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```

2. **Set the secret.** Invent a long random string. In the Supabase dashboard,
   Edge Functions → Secrets, add `INGEST_SECRET`. `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` are provided automatically — never copy the
   service-role key anywhere else.

3. **Create the script.** At script.google.com, new project, paste
   `sync/apps-script/Code.gs`. In Project Settings → Script properties add:

   | Key | Value |
   | --- | --- |
   | `INGEST_URL` | `https://zemxydjuuugzumxjrpqf.supabase.co/functions/v1/ingest-email` |
   | `INGEST_SECRET` | the same string as above |

   That is the real URL for this project, not a template — paste it as it is.
   The ref is not a secret; it is already in the frontend bundle. What
   protects the endpoint is `INGEST_SECRET`.

4. **Authorize.** Save the file (Ctrl+S — the editor only lists saved
   functions). In the toolbar above the code, pick **`setUp`** from the
   function dropdown and click **▷ Run**.

   Google will warn that the app is unverified; it is your own script, so
   **Advanced → Go to (project name) → Allow**. The Execution log at the
   bottom should print `Ready. Watermark: <a date 30 days ago>`.

   `setUp` exists only to trigger that permission prompt and write the
   starting point. It imports nothing.

5. **Schedule.** Clock icon in the left sidebar (Triggers) → **Add Trigger**:
   function `syncNow`, source **Time-driven**, type **Minutes timer**, every
   **15 minutes**.

6. **Backfill.** Pick `syncNow` from the dropdown and Run once to confirm it
   works end to end — the log prints how many messages went over and what came
   back. To reach further back, run `resyncLast30Days` (or `…7Days` /
   `…90Days`) instead. Those wrappers exist because the Run button cannot pass
   an argument.

### Cards that spend from an account

A credit card is two accounts here — a colón balance and a dollar balance,
billed separately — and a charge is matched to the right half by its currency.

A **debit card is not an account at all**: it spends from one. BAC Mastercard
****2207 is recorded on the *Ahorros ₡* savings account rather than as a card
of its own, so its charges come off that balance instead of appearing as money
owed. A dollar purchase on it is debited in colones at the bank's rate, so a
charge whose currency does not match falls back to the card alone — but only
when exactly one account carries that card, never for a split credit card.

The two kinds of card settle differently, and the balance view treats them so:

- **Credit card** — a dollar charge sits on the dollar balance until the month
  closes. Only that month's own rate will convert it; a stale one would
  misstate what is owed, so until the rate is set the charge is left out and
  the row says how many are missing.
- **Debit card** — the bank converts at its own rate the moment the charge
  lands and the colones are gone. Holding it back would report a balance that
  is too high for money already spent, so it counts straight away: the month's
  rate if set, otherwise the most recent one. The email only ever says
  "USD 4.99", so this is a close approximation, not the bank's own figure.

### Work expenses

Two different things, kept apart:

- **The BNCR card is the company's.** They pay it directly, so that money
  never leaves your pocket. Those charges are excluded from personal spending
  and never appear as owed — they are listed under "paid by the company" for
  reference only.
- **A work expense on one of your own cards or accounts** is your money until
  it comes back. Open the charge, set its Type to *Work*, and it appears under
  **Owed to you** in Accounts, whatever card or account it was on and
  whatever month it was. Paid from savings, it comes off that balance like any
  expense — it is just not counted as spending.

Which of the two a charge is gets derived from the card it sits on, not
stored on the charge, so moving a charge to a different card corrects it.

**Getting it back.** When the reimbursement arrives, select the charges under
Owed to you and choose **Add as income**, or tick "It pays back money owed to
me" in any income. The income adds to the account; saving it settles the
charges it pays back (`reimbursement.by` on each, `reimbursement.covers` on the
income), and Activity labels it Reimbursement. Edit the income to change what
it covers; delete it and those charges are owed to you again.

### Transaction types

Every transaction has a type, kept in `transactions.scope` (0014). Personal
and Work are built in; Settings → Transaction types renames them, adds others
(a shared expense, a loan to someone, medical the insurer pays back) and sets
two switches for each:

- **Counts as spending** — whether its charges go into the budget, the
  category totals, the dashboard and the year. Personal always does. A charge
  on the company's own card never does, whatever its type.
- **Paid back to me** — whether its charges are tracked under Owed to you.

The definitions live in settings and a charge carries only the key, so
renaming a type renames it everywhere. Removing one makes its charges Personal.
Decided in `app/src/tx-types.js`; `countsAsSpending` in `tx.js` applies it.

Charges arrive **unreviewed**, so they show in the app's review badge until
you have looked at them. A re-run never overwrites a charge you have already
edited — the write ignores rows whose `ext_id` is already present.

To re-import after fixing a parser, run `resyncLast7Days` in the script.

**A ₡0 email is not a charge.** Uber, for one, checks the card for ₡0 when a
ride is requested and charges later in an email of its own. The parser skips
those (`zero-amount`), like any other email that is not a charge.

**One refused charge never blocks the rest.** A batch is saved in one
statement, so a single row the database refuses used to fail the whole run —
and the same batch was offered again every 15 minutes, failing every time. On
2 October a ₡0 Uber check did exactly that for most of a morning. Now, when the
refusal is about a row (a check, a missing or malformed value), the rows are
written one at a time: the good ones go in, the bad one is reported as
`rejected` (the script's log lists it), and the run succeeds. An outage still
fails the run, so nothing is skipped that a retry would have saved.


## Paying a card, income, and cutoff reminders

**Transfer to card** pays a credit card from savings. It is one transaction
row with both ends on it — `account_id` the savings account it left,
`counterparty_account_id` the card it paid — which is what `account_balances`
has always expected of a transfer: it comes off the savings balance and off
what the card owes. A second row for the other side would count it twice. A
transfer may not take savings below zero, and needs that account's balance
recorded to know. The debit card on `Ahorros ₡` is recorded on the savings
row, so it is a source, never a destination.

Paying a card in another currency — colones out of savings, dollars off the
card — takes two figures, because the bank converts at its own rate that day:
what left savings is `amount`, what came off the card is
`counterparty_amount` (0011), in the card's currency, used by the balance view
as it is. Within one currency the second figure is neither asked for nor
stored, and the row is what it always was.

**A card's balance** is set by tapping it in Accounts: what the bank says is
owed right now. It is a balance snapshot like a savings account's, stored
negative. Everything after it is added on top. The card's own settings (name,
network, cutoff, removing it) are behind **Settings** on the card.

**A recorded balance is a moment** (0013). Entered on the day it is dated, it
stands for the moment it was entered: anything after counts on top, anything
before is already in it. Dated an earlier day, it stands for the end of that
day, in Costa Rica time. `balance_snapshots.recorded_at` is set by a trigger
on every save, so re-entering today's balance moves the moment too, and the
view exposes the instant as `snapshot_cut`. Every sheet — expense, transfer,
income — says when an entry falls before it and so will not move the balance.

A balance can never be as of a day that had not happened when it was entered
(0015): the sheet stops at today, and one already dated ahead is read as of
the moment it was entered. Ahorros Colones was saved "as of Oct 1" on the
evening of Sep 30; read as the end of Oct 1, it swallowed every entry made on
Oct 1. Among several balances, the latest day wins and, on the same day, the
one entered last.

It used to be a day, compared in UTC: an expense entered the afternoon a
balance was recorded never moved it, while an evening charge — already the
next day in UTC — did. That, and manual entries all stamped 12:00, was why an
expense on Ahorros ₡ could leave its balance where it was.

**Manual entries keep their time.** The expense, transfer and income sheets
have a Time beside the Date. A new entry is stamped with the moment it was
started, to the second; one left untouched keeps its exact instant; a picked
date or time is taken as given. 0013 gives entries already stamped at noon on
the day they were entered the moment they were actually entered.

**Adding and removing cards.** Accounts → Add account → Credit card adds the
card's colón and dollar balances together (or only one), with its network,
cutoff and who pays it. A bank whose emails are not read is *Another bank*;
its charges are added by hand. **Remove card** archives both halves: they
leave every list, total and reminder, and their transactions stay in
Activity.

**The company's card** (BNCR, and any card added as paid by *My company*) is
left out of net position — only personal accounts are summed — and out of
spending. Spending decides by the card as well as the charge's own Work flag,
so a charge on that card counts as work even if it is marked Personal.

**Add income** puts money into a savings account as `kind = 'income'`. Neither
kind is spending: both are left out of every spending total, show in Activity
with their own label, and appear under each account they touch.

**Cutoffs** are set per credit card — Accounts, the card's Settings: the day of the month the statement closes, and how many days before
to be reminded. Both currency halves of a card share them. The dashboard lists
every cutoff, soonest first, marked once inside its card's window.

Reminders are Web Push to each device with them switched on in Settings → Notifications. Which cards are
due, and whether a reminder already went out, is decided in
`supabase/functions/_shared/cutoff.js` and `reminders.js` — the same module
the dashboard uses, under node tests. A reminder is recorded before it is
sent, so the daily job never sends one twice, catches up if it missed a day,
and retries if nothing was delivered. Email would be another delivery in the
same loop; there is no mail provider in this project yet.

```
Apps Script (daily) ──▶ POST /functions/v1/send-cutoff-reminders ──▶ web push ──▶ sw.js
```

### Setting it up

In this order — the app reads the new columns, so it breaks if deployed first.

1. **Migrate.** SQL Editor → paste `supabase/migrations/0010_cutoffs_and_reminders.sql`
   → Run. Safe to run twice.

2. **Secrets.** `supabase/.env.local` (git-ignored) holds the VAPID key pair
   the app subscribes with — its public half is also in
   `app/src/push-config.js`. Replace `REPLACE-WITH-YOUR-EMAIL` in
   `VAPID_SUBJECT` with a `mailto:` address or the app's `https:` URL (the
   push services' contact for whoever sends), then:

   ```
   npx supabase secrets set --env-file supabase/.env.local
   ```

   The function also uses `INGEST_SECRET`, which is already set.

3. **Deploy the function.**

   ```
   npx supabase functions deploy send-cutoff-reminders --no-verify-jwt
   ```

4. **Apps Script.** Paste the new `sync/apps-script/Code.gs` over the old one,
   save, then Triggers → Add Trigger: function `sendReminders`, Time-driven,
   Day timer, 7am to 8am. Run it once by hand: the log says what was due and
   sent.

5. **Deploy the app** (push to `main`), then on each device: Settings →
   Notifications → Turn on. On iPhone and iPad this works only in the app
   added to the Home Screen, not in a Safari tab — the switch says so.

To try a reminder without waiting for a cutoff, post a day to the function:

```
curl -X POST https://zemxydjuuugzumxjrpqf.supabase.co/functions/v1/send-cutoff-reminders \
  -H "x-ingest-secret: <INGEST_SECRET>" -d '{"today":"2026-10-13"}'
```

That records the reminder as sent, like a real run would.


## A notification for each new charge

When the sync brings in a charge, the ingest function announces it on every
device with notifications on — the same Web Push, service worker and VAPID
keys as the cutoff reminders:

```
Apps Script (15 min) ──▶ ingest-email ──▶ insert ──▶ the rows actually inserted ──▶ web push ──▶ sw.js
```

- **Only what is new.** The insert ignores duplicates and returns only the
  rows it created, so a charge is announced once however often its email is
  seen. A charge posted more than a day ago is history being re-imported (a
  resync after a parser fix), and is not announced at all.
- **One each, or a summary.** Up to three at once arrive one by one — "₡38,500
  at Auto Mercado", with the card and its category, or "Tap to categorize".
  More than that arrive as one "5 new charges". Tapping one opens that charge
  in the app, ready to categorize (`/?view=transactions&tx=<id>`).
- **Never at the import's expense.** Sending runs after the charges are saved,
  cannot throw, and gives up after 15 seconds. The response carries a
  `notified` report, and the Apps Script log adds "N notification(s) sent".
- **Per device.** Settings → Notifications has a switch for new charges and
  one for cutoff reminders (`push_subscriptions.notify_charges` /
  `notify_cutoffs`, 0012), so a phone can have both and a laptop neither.

Decided in `supabase/functions/_shared/charge-alerts.js`, under node tests;
the edge function is wiring.

### The screen follows by itself

`app/src/live.js` reloads the data — not the page — when:

- a new-charge notification reaches the device: the service worker tells any
  open window;
- the ledger changed, checked once a minute while the app is on screen, by
  one indexed row (the count and the newest `updated_at`);
- the app comes back after two minutes or more in the background: then
  everything is reloaded, budget included, as another device may have
  changed it.

It never reloads under someone: with a sheet open or the cursor in a field,
it waits and catches up seconds after they finish.

### Setting it up

1. **Migrate.** SQL Editor → paste `supabase/migrations/0012_charge_notifications.sql`
   → Run. Safe to run twice. Before the function and the app: both read the
   new columns.
2. **Deploy both functions** — ingest-email sends the alerts, and
   send-cutoff-reminders now respects each device's switch:

   ```
   npx supabase functions deploy ingest-email --no-verify-jwt
   npx supabase functions deploy send-cutoff-reminders --no-verify-jwt
   ```

3. **Deploy the app** (push to `main`). Devices already switched on get both
   kinds; nothing to redo on the phone.
4. *(Optional)* Paste the new `sync/apps-script/Code.gs` over the old one for
   the "notification(s) sent" line in the sync's log. The sync works the same
   without it.

Charges arrive as fast as the sync runs. For quicker alerts, set the
`syncNow` trigger to every 5 minutes instead of 15.


## Installing it on a phone

The app is a PWA, so it installs to a home screen and opens without browser
chrome.

- **Android / Chrome** — open the site, menu ⋮ → *Add to Home screen*, or take
  the install prompt when Chrome offers one.
- **iOS / Safari** — Share → *Add to Home Screen*. Safari does not offer a
  prompt, and only Safari can install; Chrome on iOS cannot.

`app/public/sw.js` caches the app shell and its hashed assets so it opens
instantly. It deliberately does **not** cache anything from Supabase. The data
is the whole point of the app, and a budget quietly showing yesterday's
numbers is worse than a screen that admits it is offline. Opened with no
network, the app loads and then reports that it cannot reach your data.

Bump `VERSION` in `sw.js` if the cached shell ever needs to be thrown away
deliberately. Ordinary deploys do not need it — navigations are network-first,
so a running app picks up a new build as soon as it is online.
