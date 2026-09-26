# Finance Advisor

The app, split out of the original single-file `finance-advisor.html`, built
with Vite and backed by Supabase.

## Run

```
npm install
cp .env.example .env.local     # fill in your Supabase URL + anon key
npm run dev                    # http://localhost:5173
npm run build                  # -> dist/
npm test                       # persistence unit tests
```

Without credentials the app renders a "Not configured" card rather than
failing silently.

To work on the screens without touching real data, open
`http://localhost:5173/?demo`. It skips sign-in and loads a month of sample
accounts, charges, plans and goals (`src/demo.js`) into the in-memory
repository, dated relative to today. Only the dev server honours it — a build
does not contain the module at all. Add `&view=accounts` (or any view) to open
straight on one; the home-screen shortcuts in the manifest use the same
parameter.

## Layout

| File | Holds |
| --- | --- |
| `index.html` | Shell: sign-in gate, sidebar, top bar, phone tab bar, `#views` mount, sheet, toast |
| `src/styles.css` | The design system: light and dark tokens, the shell, components, each view |
| `src/icons.js` | Inline SVG icons, and the pictures for accounts, cards, merchants and goals |
| `src/charts.js` | The spending-pace line, the year's bars and the category ring |
| `src/demo.js` | Sample data for `/?demo` on the dev server |
| `src/state.js` | State shape, dirty-tracking, batched persistence |
| `src/repo.js` | The storage contract, and the test injection seam |
| `src/supabase-repo.js` | Real implementation |
| `src/memory-repo.js` | In-memory implementation, for tests |
| `src/auth.js` | Sign-in gate |
| `src/app.js` | Compute engine, the five original view renderers, mutations |
| `src/tx.js` | Transaction data, caching, rule matching, totals |
| `src/views-tx.js` | The transactions view |
| `src/tx-actions.js` | Its edit sheet and filters |
| `src/main.js` | Bootstrap, DOM wiring, `window.*` bindings |

## How saving works

`save()` is still a plain synchronous call made from ~20 mutation sites, and
it still never throws. What changed is what it does:

1. It marks the state dirty and schedules a flush 700ms later. Typing in an
   input never waits on a round trip.
2. The flush diffs the whole state against a snapshot of what the server is
   believed to hold, and writes only the months that actually changed. Call
   sites do not say what they touched, and comparing a dozen small month
   objects costs nothing next to a request.
3. A month present in the snapshot but missing from state is **deleted**
   server-side. Without this, "erase all data" wipes only the local copy and
   everything returns at the next sign-in.
4. Each write is marked clean only once it lands, so a failure halfway through
   leaves the rest pending rather than dropping it. Failures retry and show
   "Not saved — retrying" in the sidebar.

`test/state.test.js` covers all four, including the failure paths.

## Transactions

The ledger lives in its own tables and its own modules, deliberately apart from
`state.js`. The monthly plan is a small blob loaded and written whole;
transactions are rows, loaded per month and written one at a time. Mixing them
would drag the whole ledger through the budget save path on every keystroke.

Writes here are immediate rather than debounced — adding or categorizing is a
deliberate action, not typing.

Two figures that look alike and are not:

- **Uncategorized** — no category at all. The review queue clears these, and it
  is the Uncategorized figure in the Activity summary.
- **Unbudgeted** — categorized, but not attached to a plan line. Until budget
  lines are assignable in the UI, nearly everything is unbudgeted, so showing
  it now would be noise. `spendTotals()` computes both.

Work-scope charges and transfers never count toward personal spending. A
transfer moves money; it does not spend it.

## Currencies

Each card is two accounts, not one: `BAC VISA ₡` and `BAC VISA $`. That mirrors
how a Costa Rican credit card actually works — a colón balance and a dollar
balance, billed and settled separately.

A foreign charge therefore stores **only its own currency**. Converting it on
the day it happens would invent a number: nothing is converted until the dollar
balance is paid, at whatever rate applies then. So:

- `transactions.amount_crc` is null for a foreign charge
- `fx_rates` holds one rate per currency per month, entered when the statement
  is paid
- `effectiveCrc()` derives the colón value; it returns null when no rate is set
- Unconverted charges are **excluded from every colón total** and surfaced
  separately ("$141.86 on foreign-currency balances"), rather than counted as
  zero or guessed at

Known simplification: statement cycles do not align with calendar months —
Davivienda cuts on the 15th — so a month's rate is close to, not identical to,
what any single statement charged.

## Design

One stylesheet, organised as tokens, shell, components, then views. Colours
are custom properties with a light and a dark set; the theme follows the
device unless one is picked in Settings, which is remembered per device in
`localStorage` and applied by an inline script in `index.html` before the
first paint, so a dark choice never flashes light.

The category colours (essentials, discretionary, savings, investing) were
validated as a set for colour-blind separation in both themes. Charts carry
a legend or the figures beside them, so no value is readable by colour alone,
and each has the same readout on keyboard focus as on hover.

Icons are inline SVG strings from `icons.js`, so they inherit `currentColor`
and need nothing extra cached. The same module draws an account's picture:
a card in its bank's colours with its network's mark, a bank monogram for
savings, a type icon for cash and investments. The banks are monograms, not
logos — enough to find a card at a glance, and nothing to go stale.

The font is Inter, bundled from `@fontsource-variable/inter` rather than
loaded from a CDN, so it lands in `/assets/` and the service worker caches it
like any other asset.

## Mobile

Below 880px the app is laid out as a phone app rather than a narrow desktop:

- The sidebar is replaced by a tab bar — Home, Budget, Activity, Accounts —
  with Add expense in the middle. Goals, Year in review and Settings sit
  behind the avatar at the top right.
- Every dialog is a bottom sheet with its action row pinned, so Save is never
  below the fold.
- Inputs are 16px, the size under which iOS zooms the page on focus.
- `viewport-fit=cover` plus the safe-area insets keep the tab bar clear of the
  home indicator in the installed app.
- The Budget keeps the unassigned figure pinned while scrolling, and plan
  rows wrap into name and amount, then type, then spending.

Tested at 360, 390 and 820px wide, in both themes.

## Things left deliberately

- **`app.js` is still one file.** The five renderers share `currentMonth`,
  `annualYear` and `activeView`. Splitting them now means threading that state
  through accessors for no present benefit.
- **Inline `onclick=` handlers.** The generated HTML calls globals, so
  `main.js` assigns them to `window`. Worth removing when the transactions
  view forces a rethink of rendering — not before.
- **No offline cache.** Connectivity is required, by choice. Adding one later
  means a second repository implementation, not a change to the app.

## Verifying a refactor

`tools/smoke.mjs` loads an app, seeds a fixed dataset and a frozen clock,
clicks through all five views, and prints a JSON fingerprint of rendered text
plus console and page errors. It seeds both localStorage and an injected
repository, so the same script fingerprints the original single-file app and
this one.

```
node ../tools/smoke.mjs ../finance-advisor.html > /tmp/baseline.json
npm run build && npx vite preview --port 4210 &
node ../tools/smoke.mjs http://localhost:4210/ > /tmp/after.json
diff /tmp/baseline.json /tmp/after.json     # must be empty
```

It was empty as of the Supabase migration: every rendered number unchanged
from the original app. The redesign changed the words and layout on purpose,
so the text no longer diffs clean; what was checked instead is that every
figure the previous version rendered — on those five views, and on Home,
Activity and Accounts with a full ledger loaded — still appears in the new
one.

`tools/gate-check.mjs` checks the unauthenticated path — that the app stays
hidden and the gate renders.

`tools/tx-smoke.mjs` drives the transactions view against a seeded repository:
rendering, day grouping, totals, filters, adding through the modal, editing,
and the review badge. 18 checks.

`tools/shot.mjs` writes desktop and 390px screenshots, which is how the broken
mobile layout and the unstyled stat row were both caught.
