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
npm run dev
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

Browser-level checks live in `tools/` and need the app running:

```
node tools/smoke.mjs    http://localhost:4173/            # the five original views
node tools/tx-smoke.mjs http://localhost:4173/            # the transactions view
node tools/pwa-check.mjs http://localhost:4173/ app/dist  # install, offline, update
```

`pwa-check.mjs` needs the build directory as well as the URL: proving that an
update reaches an installed app means publishing one, so it edits the served
files and puts them back.


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

### Work expenses

Two different things, kept apart:

- **The BNCR card is the company's.** They pay it directly, so that money
  never leaves your pocket. Those charges are excluded from personal spending
  and never appear as owed — they are listed under "paid by the company" for
  reference only.
- **A work expense on one of your own cards** is your money until it comes
  back. Open the charge on the Transactions tab, set Scope to *Work*, and it
  appears under **Work — owed to you** in Accounts, whatever card it was on
  and whatever month it was.

Which of the two a charge is gets derived from the card it sits on, not
stored on the charge, so moving a charge to a different card corrects it.

Charges arrive **unreviewed**, so they show in the app's review badge until
you have looked at them. A re-run never overwrites a charge you have already
edited — the write ignores rows whose `ext_id` is already present.

To re-import after fixing a parser, run `resyncLast7Days` in the script.


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
