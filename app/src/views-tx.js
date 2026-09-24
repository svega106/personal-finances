/**
 * The transactions view: the ledger for one month.
 *
 * Rendering is async because rows come from the server, so this paints a
 * skeleton first and fills it in. `render()` in app.js stays synchronous.
 */
import { money, uid } from './state.js';
import {
  loadMonth, cachedMonth, getAccounts, accountById, matchRule,
  saveTransaction, removeTransaction, spendTotals, unreviewedCount,
  effectiveCrc, rateFor, setMonthRate,
} from './tx.js';

const CATS = [
  ['needs', 'Essentials'],
  ['wants', 'Discretionary'],
  ['savings', 'Savings'],
];

const filters = { account: 'all', cat: 'all', unreviewedOnly: false };
let currentRows = [];
let currentKey = null;

export function txFilters() { return filters; }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

/**
 * The Costa Rica calendar day a charge belongs to, as YYYY-MM-DD.
 *
 * Postgres returns `timestamptz` normalized to UTC, so slicing the string
 * gives the UTC date — and any charge after 6pm local is already "tomorrow"
 * there. That split one evening across two headings and sorted an 8pm charge
 * below a midday one. The day has to be computed in the zone the card was
 * actually used in.
 */
function dayKey(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
}

/** Takes the key from dayKey(), not a raw timestamp. */
function dayLabel(key) {
  // Noon, so the label cannot be dragged into the neighbouring day by an
  // offset the way a bare `new Date('2026-09-21')` (UTC midnight) would be.
  return new Date(`${key}T12:00:00-06:00`).toLocaleDateString('en-US', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Costa_Rica',
  });
}
function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Costa_Rica',
  });
}

function displayName(t) {
  return t.merchant || t.merchantRaw || '(no merchant)';
}

function accountChip(t) {
  const a = accountById(t.accountId);
  if (!a) return '';
  const tail = a.last4 ? ` ····${a.last4}` : '';
  return `<span class="tx-acct">${esc(a.label)}${tail}</span>`;
}

function catChip(t) {
  if (t.kind === 'transfer') return '<span class="tx-cat tx-transfer">Transfer</span>';
  if (t.scope === 'work') return '<span class="tx-cat tx-work">Work</span>';
  if (!t.cat) return '<span class="tx-cat tx-none">Unbudgeted</span>';
  const label = (CATS.find(([k]) => k === t.cat) || [, t.cat])[1];
  return `<span class="tx-cat tx-${t.cat}">${esc(label)}</span>`;
}

function fmtForeign(t) {
  return `${t.currency === 'USD' ? '$' : t.currency + ' '}${t.amount.toFixed(2)}`;
}

function amountCell(t) {
  const sign = t.kind === 'income' ? '+' : '';
  if (t.currency === 'CRC') {
    return `<div class="tx-amt">${sign}${money(t.amount)}</div>`;
  }
  const crc = effectiveCrc(t);
  // No rate yet: lead with the real number, and say so rather than showing ₡0.
  return crc == null
    ? `<div class="tx-amt">${sign}${fmtForeign(t)}<span class="tx-fx tx-unconv">not converted</span></div>`
    : `<div class="tx-amt">${sign}${money(crc)}<span class="tx-fx">${fmtForeign(t)}</span></div>`;
}

/* ----------------------------------------------------------------- view */

export function renderTransactions(views, monthKey) {
  currentKey = monthKey;
  const cached = cachedMonth(monthKey);

  views.innerHTML = shell(cached ?? null, monthKey);
  if (cached) {
    currentRows = cached;
    updateNavBadge(cached); // the cached path must refresh it too
    settleFlash();
    return;
  }

  loadMonth(monthKey)
    .then((rows) => {
      if (currentKey !== monthKey) return; // month changed while loading
      currentRows = rows;
      views.innerHTML = shell(rows, monthKey);
      updateNavBadge(rows);
      settleFlash();
    })
    .catch((err) => {
      views.innerHTML = `<div class="card"><h3>Could not load transactions</h3>
        <p class="muted" style="font-size:13px">${esc(err.message)}</p></div>`;
    });
}

function shell(rows, monthKey) {
  if (rows === null) {
    return `<div class="card"><p class="muted" style="font-size:13px">Loading transactions…</p></div>`;
  }

  const visible = rows.filter((t) => {
    if (filters.account !== 'all' && t.accountId !== filters.account) return false;
    if (filters.cat !== 'all') {
      if (filters.cat === 'none' ? !!t.cat : t.cat !== filters.cat) return false;
    }
    if (filters.unreviewedOnly && t.reviewed) return false;
    return true;
  });

  const totals = spendTotals(rows);
  const needsReview = unreviewedCount(rows);

  return `
    ${summary(totals, needsReview, rows.length)}
    ${toolbar(needsReview)}
    ${visible.length ? groupByDay(visible) : empty(rows.length)}
  `;
}

function summary(t, needsReview, count) {
  // Uses the dashboard's own card/grid/stat classes so the two views read as
  // one app rather than two that happen to share a colour scheme.
  const card = (label, value, sub, colour) => `
    <div class="card">
      <h3>${label}</h3>
      <div class="stat"${colour ? ` style="color:${colour}"` : ''}>${value}</div>
      <div class="muted" style="font-size:12px;margin-top:3px">${sub}</div>
    </div>`;

  return `
  <div class="grid g4" style="margin-bottom:4px">
    ${card('Spent this month', money(t.total), `${count} transaction${count === 1 ? '' : 's'}`)}
    ${card('Essentials', money(t.needs), 'needs')}
    ${card('Discretionary', money(t.wants), 'wants')}
    ${card('Uncategorized', money(t.uncategorized),
           needsReview ? `${needsReview} to review` : 'all reviewed',
           t.uncategorized > 0 ? 'var(--warn)' : null)}
  </div>
  ${pendingNote(t)}`;
}

/**
 * Foreign charges are billed on their own balance and settled later, so their
 * colón value is unknown until the month's rate is entered. Saying that is
 * more useful than folding a guess into the totals.
 */
function pendingNote(t) {
  const entries = Object.entries(t.pending).filter(([, v]) => v > 0);
  if (!entries.length) return '';
  const amounts = entries
    .map(([cur, v]) => `${cur === 'USD' ? '$' : cur + ' '}${v.toFixed(2)}`)
    .join(' + ');
  return `
  <div class="card tx-pending">
    <div>
      <b>${amounts}</b> on foreign-currency balances
      <span class="muted">· ${t.pendingCount} charge${t.pendingCount === 1 ? '' : 's'} not in the totals above</span>
    </div>
    <button class="btn ghost sm" onclick="txRateModal()">Set this month's rate</button>
  </div>`;
}

function toolbar(needsReview) {
  const accs = getAccounts().filter((a) => a.type === 'card' || a.type === 'cash');
  return `
  <div class="card tx-bar" style="margin-top:16px">
    <div class="tx-filters">
      <select class="inp sm" onchange="txSetFilter('account',this.value)">
        <option value="all"${filters.account === 'all' ? ' selected' : ''}>All accounts</option>
        ${accs.map((a) => `<option value="${esc(a.id)}"${filters.account === a.id ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}
      </select>
      <select class="inp sm" onchange="txSetFilter('cat',this.value)">
        <option value="all"${filters.cat === 'all' ? ' selected' : ''}>All categories</option>
        ${CATS.map(([k, l]) => `<option value="${k}"${filters.cat === k ? ' selected' : ''}>${l}</option>`).join('')}
        <option value="none"${filters.cat === 'none' ? ' selected' : ''}>Unbudgeted</option>
      </select>
      <label class="tx-check">
        <input type="checkbox" ${filters.unreviewedOnly ? 'checked' : ''}
               onchange="txSetFilter('unreviewedOnly',this.checked)">
        Needs review${needsReview ? ` (${needsReview})` : ''}
      </label>
    </div>
    <button class="btn" onclick="txEdit()">+ Add expense</button>
  </div>`;
}

function empty(totalInMonth) {
  return `<div class="card" style="text-align:center;padding:36px 20px">
    <h3 style="margin:0 0 6px">${totalInMonth ? 'Nothing matches those filters' : 'No transactions yet'}</h3>
    <p class="muted" style="font-size:13px;margin:0 0 16px">
      ${totalInMonth
        ? 'Clear a filter to see the rest of the month.'
        : 'Card charges arrive from your bank emails once the sync runs. Until then, add them by hand.'}
    </p>
    ${totalInMonth ? '' : '<button class="btn" onclick="txEdit()">+ Add expense</button>'}
  </div>`;
}

function groupByDay(rows) {
  const days = new Map();
  for (const t of rows) {
    const k = dayKey(t.postedAt);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(t);
  }

  return [...days.entries()].map(([day, list]) => {
    // effectiveCrc, not amountCrc: a foreign charge has no colón value of its
    // own, so a raw read would silently drop it from the day even after the
    // month's rate has been set.
    const dayTotal = list.reduce((s, t) => {
      if (t.kind !== 'expense' || t.scope === 'work') return s;
      return s + (effectiveCrc(t) ?? 0);
    }, 0);
    return `
    <div class="tx-day">
      <div class="tx-day-head">
        <span>${dayLabel(day)}</span>
        <span class="muted">${money(dayTotal)}</span>
      </div>
      <div class="card tx-list">
        ${list.map(row).join('')}
      </div>
    </div>`;
  }).join('');
}

function row(t) {
  const flash = t.id && t.id === flashId ? ' tx-flash' : '';
  return `
  <div class="tx-row${t.reviewed ? '' : ' tx-unreviewed'}${flash}"
       id="tx-${esc(t.id)}" onclick="txEdit('${esc(t.id)}')">
    <div class="tx-main">
      <div class="tx-name">${esc(displayName(t))}${t.reviewed ? '' : '<span class="tx-dot" title="Not reviewed"></span>'}</div>
      <div class="tx-meta">${timeLabel(t.postedAt)} ${accountChip(t)} ${catChip(t)}</div>
    </div>
    ${amountCell(t)}
  </div>`;
}

/* ---------------------------------------------------------- landing spot */

/**
 * Where the eye should go after a save.
 *
 * A charge added to a month with sixty others lands wherever its date puts
 * it, which can be off screen — the toast says it saved, but nothing visibly
 * happens. This marks the row so the next paint scrolls to it and flashes it
 * once.
 */
let flashId = null;

export function flashRow(id) { flashId = id ?? null; }

/**
 * Told when a saved row is in the month but hidden by an active filter.
 *
 * Registered by tx-actions, which can reach `toast`. This module deliberately
 * does not import app.js — see the header.
 */
let onHidden = () => {};
export function onFlashHidden(fn) { onHidden = fn; }

/** Called right after the view's HTML is in the DOM. */
function settleFlash() {
  if (!flashId) return;
  const id = flashId;
  flashId = null;

  const el = document.getElementById(`tx-${id}`);
  if (el) {
    // Not 'smooth': on a long list the scroll outlasts the highlight.
    el.scrollIntoView({ block: 'center' });
    return;
  }
  // It saved, it is in the month, and the filter you set earlier is hiding
  // it. Silence here looks exactly like a save that did not work.
  if (currentRows.some((t) => t.id === id)) onHidden();
}

/* ------------------------------------------------------------ nav badge */

export function updateNavBadge(rows) {
  const btn = document.querySelector('#nav button[data-view="transactions"]');
  if (!btn) return;
  const n = unreviewedCount(rows ?? currentRows);
  let b = btn.querySelector('.badge');
  if (!n) { b?.remove(); return; }
  if (!b) { b = document.createElement('span'); b.className = 'badge'; btn.appendChild(b); }
  b.textContent = String(n);
}

/* ------------------------------------------------------------- editing */

export function findRow(id) {
  return currentRows.find((t) => t.id === id) || null;
}

export function blankTx(monthKey) {
  // Default to today when the visible month is the current one, else the 1st,
  // so a manual entry never silently lands in a month you are not looking at.
  //
  // Today is the Costa Rica day, not the UTC one. Slicing an ISO string dates
  // anything entered after 6pm as tomorrow — and on the last evening of a
  // month, into the next month, where it is saved but invisible.
  const today = dayKey(new Date());
  const thisMonth = today.slice(0, 7) === monthKey;
  const date = thisMonth ? today : `${monthKey}-01`;
  return {
    id: null,
    extId: `manual:${uid()}${Date.now().toString(36)}`,
    kind: 'expense',
    postedAt: `${date}T12:00:00-06:00`,
    merchantRaw: '',
    merchant: '',
    amount: 0,
    currency: 'CRC',
    amountCrc: 0,
    accountId: null,
    scope: 'personal',
    cat: 'wants',
    budgetLineId: null,
    source: 'manual',
    method: 'cash',
    status: 'settled',
    reviewed: true,
    note: '',
  };
}

export { CATS, esc };
// Exported for tests: the timezone handling here is easy to get wrong and
// was wrong once already.
export { dayKey, dayLabel };
export { saveTransaction, removeTransaction, matchRule, loadMonth };
