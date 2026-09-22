# Personal Finances

A monthly budgeting app that tracks planned spending against what actually
happened, with card charges read from bank notification emails.

## Layout

| Folder | Holds |
| --- | --- |
| `app/` | The web app — Vite, vanilla JS, Supabase |
| `supabase/` | Database migrations, run in order |
| `sync/` | Bank email parsers, and later the sync worker |
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
cd app  && npm test                      # persistence
cd sync && node --test "test/*.test.js"  # email parsers
```

Browser-level checks live in `tools/` and need the app running:

```
node tools/smoke.mjs    http://localhost:4173/   # the five original views
node tools/tx-smoke.mjs http://localhost:4173/   # the transactions view
```
