/**
 * The transactions view: the ledger for one month.
 *
 * Rendering is async because rows come from the server, so this paints a
 * skeleton first and fills it in. `render()` in app.js stays synchronous.
 */
import { money, uid, monthLabel } from './state.js';
import { crDay as dayKey, crMonth, crDayLabel as dayLabel, crTimeLabel as timeLabel, crNoon } from './cr-date.js';
import {
  loadMonth, cachedMonth, getAccounts, accountById, matchRule, findCached,
  saveTransaction, removeTransaction, spendTotals, unreviewedCount,
  effectiveCrc, rateFor, setMonthRate,
} from './tx.js';
import { icon, merchantIcon, accountIcon } from './icons.js';

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

function displayName(t) {
  return t.merchant || t.merchantRaw || '(no merchant)';
}

/** The account a charge sat on, with a small picture of it. */
function accountChip(t) {
  const a = accountById(t.accountId);
  if (!a) return '';
  const tail = a.last4 ? `<span class="tail">••${esc(a.last4)}</span>` : '';
  return `<span class="tx-acct">${accountIcon(a, { size: 'xs' })}${esc(a.label)}${tail}</span>`;
}

function catChip(t) {
  if (t.kind === 'transfer') return '<span class="tx-cat tx-transfer">Transfer</span>';
  if (t.kind === 'income') return '<span class="tx-cat tx-income">Income</span>';
  if (t.scope === 'work') return '<span class="tx-cat tx-work">Work</span>';
  if (!t.cat) return '<span class="tx-cat tx-none">Uncategorized</span>';
  const label = (CATS.find(([k]) => k === t.cat) || [, t.cat])[1];
  return `<span class="tx-cat tx-${t.cat}">${esc(label)}</span>`;
}

/** A foreign amount as it was charged: $1,234.50. */
function foreign(amount, currency) {
  const n = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency === 'USD' ? '$' : `${currency} `}${n}`;
}

/** A charge's amount, in colones when it can be, with the original beneath. */
export function amountCell(t) {
  const sign = t.kind === 'income' ? '+' : '';
  const cls = t.kind === 'income' ? 'tx-amt in' : 'tx-amt';
  if (t.currency === 'CRC') {
    return `<div class="${cls}">${sign}${money(t.amount)}</div>`;
  }
  const crc = effectiveCrc(t);
  // No rate yet: lead with the real number, and say so rather than showing ₡0.
  return crc == null
    ? `<div class="${cls}">${sign}${foreign(t.amount, t.currency)}<span class="tx-fx tx-unconv">not converted</span></div>`
    : `<div class="${cls}">${sign}${money(crc)}<span class="tx-fx">${foreign(t.amount, t.currency)}</span></div>`;
}

/**
 * A day as people say it: "Today", "Yesterday", or the date. The date is
 * kept beside the word, so the day is always there to read.
 */
export function dayName(day, { short = false } = {}) {
  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 86400000));
  const word = day === today ? 'Today' : day === yesterday ? 'Yesterday' : '';
  if (short) return word || dayLabel(day);
  return word ? `<b>${word}</b>${dayLabel(day)}` : dayLabel(day);
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
      views.innerHTML = `<div class="card empty">
        <div class="empty-ic" style="color:var(--neg);background:color-mix(in srgb,var(--neg) 12%,transparent)">${icon('alert')}</div>
        <h3>Could not load transactions</h3><p>${esc(err.message)}</p></div>`;
    });
}

function shell(rows, monthKey) {
  if (rows === null) return skeleton();

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
    ${summary(totals, needsReview, rows.length, monthKey)}
    ${pendingNote(totals)}
    ${toolbar(needsReview, rows)}
    ${visible.length ? groupByDay(visible) : empty(rows.length)}
  `;
}

/** Placeholders in the shape of what is coming, while the month loads. */
function skeleton() {
  const row = `<div class="skel-row"><div class="skel skel-circle"></div>
    <div class="skel-lines"><div class="skel skel-line" style="width:46%"></div><div class="skel skel-line" style="width:30%"></div></div>
    <div class="skel skel-line" style="width:64px"></div></div>`;
  return `<span class="sr-only">Loading transactions…</span>
    <div class="card tx-summary" aria-hidden="true">
      <div><div class="skel skel-line" style="width:40%"></div><div class="skel" style="height:34px;width:60%;margin:10px 0"></div><div class="skel skel-line" style="width:50%"></div></div>
      <div><div class="skel" style="height:12px;border-radius:99px"></div><div class="skel skel-line" style="width:80%;margin-top:18px"></div></div>
    </div>
    <div class="tx-day" aria-hidden="true"><div class="list">${row.repeat(5)}</div></div>`;
}

function summary(t, needsReview, count, monthKey) {
  const segs = [
    ['needs', 'Essentials', t.needs],
    ['wants', 'Discretionary', t.wants],
    ['savings', 'Savings', t.savings],
    ['none', 'Uncategorized', t.uncategorized],
  ].filter(([, , v]) => v > 0);
  const bar = segs.length
    ? segs.map(([k, l, v]) => `<i class="tone-${k}" style="flex:${v} 1 0" title="${l}: ${money(v)}"></i>`).join('')
    : '<i class="rest" style="flex:1 1 0"></i>';
  const name = monthLabel(monthKey).split(' ')[0];

  return `
  <section class="card tx-summary">
    <div>
      <div class="txs-label">Spent in ${name}</div>
      <div class="stat txs-total" data-stat="total">${money(t.total)}</div>
      <div class="txs-sub">${count} transaction${count === 1 ? '' : 's'}
        ${needsReview
          ? `<span class="pill warn">${needsReview} to review</span>`
          : '<span class="pill good">all reviewed</span>'}</div>
    </div>
    <div>
      <div class="stackbar">${bar}</div>
      <div class="txs-cats">
        <div class="txs-cat tone-needs"><div class="lbl"><span class="swatch"></span>Essentials</div><div class="stat" data-stat="needs">${money(t.needs)}</div></div>
        <div class="txs-cat tone-wants"><div class="lbl"><span class="swatch"></span>Discretionary</div><div class="stat" data-stat="wants">${money(t.wants)}</div></div>
        <div class="txs-cat tone-none${t.uncategorized > 0 ? ' flag' : ''}"><div class="lbl"><span class="swatch"></span>Uncategorized</div><div class="stat" data-stat="uncategorized">${money(t.uncategorized)}</div></div>
      </div>
    </div>
  </section>`;
}

/**
 * Foreign charges are billed on their own balance and settled later, so their
 * colón value is unknown until the month's rate is entered. Saying that is
 * more useful than folding a guess into the totals.
 */
function pendingNote(t) {
  const entries = Object.entries(t.pending).filter(([, v]) => v > 0);
  if (!entries.length) return '';
  const amounts = entries.map(([cur, v]) => foreign(v, cur)).join(' + ');
  return `
  <div class="banner tx-pending">
    <span class="banner-ic">${icon('globe')}</span>
    <div class="banner-text">
      <b>${amounts}</b> on foreign-currency balances
      <div class="muted">${t.pendingCount} charge${t.pendingCount === 1 ? '' : 's'} not in the totals above</div>
    </div>
    <button class="btn ghost sm" onclick="txRateModal()">Set this month's rate</button>
  </div>`;
}

function toolbar(needsReview, rows) {
  // Cards and cash, plus any account that has charges this month — a savings
  // account spends through its debit card.
  const used = new Set(rows.map((t) => t.accountId));
  const accs = getAccounts().filter((a) => a.type === 'card' || a.type === 'cash' || used.has(a.id));
  const chip = (k, label) => `<button type="button" class="chip${filters.cat === k ? ' on' : ''}"
      aria-pressed="${filters.cat === k}"
      onclick="txSetFilter('cat','${filters.cat === k && k !== 'all' ? 'all' : k}')">${k === 'all' ? '' : `<span class="dot tone-${k}"></span>`}${label}</button>`;
  return `
  <div class="tx-toolbar">
    <div class="chips" role="group" aria-label="Category">
      ${chip('all', 'All')}
      ${CATS.map(([k, l]) => chip(k, l)).join('')}
      ${chip('none', 'Uncategorized')}
    </div>
    <div class="tx-tools">
      <button type="button" class="chip${filters.unreviewedOnly ? ' on' : ''}" aria-pressed="${filters.unreviewedOnly}"
              onclick="txSetFilter('unreviewedOnly',${!filters.unreviewedOnly})">
        ${icon('inbox', { size: 16 })}Needs review${needsReview ? ` <span class="count">${needsReview}</span>` : ''}
      </button>
      <select class="chip" aria-label="Account" onchange="txSetFilter('account',this.value)">
        <option value="all"${filters.account === 'all' ? ' selected' : ''}>All accounts</option>
        ${accs.map((a) => `<option value="${esc(a.id)}"${filters.account === a.id ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}
      </select>
    </div>
  </div>`;
}

function empty(totalInMonth) {
  return `<div class="card empty" style="margin-top:18px">
    <div class="empty-ic">${icon(totalInMonth ? 'search' : 'inbox')}</div>
    <h3>${totalInMonth ? 'Nothing matches those filters' : 'No transactions yet'}</h3>
    <p>${totalInMonth
      ? 'Clear a filter to see the rest of the month.'
      : 'Card charges arrive from your bank emails once the sync runs. Until then, add them by hand.'}</p>
    ${totalInMonth
      ? `<button class="btn ghost" onclick="txClearFilters()">${icon('x')}Clear filters</button>`
      : `<button class="btn" onclick="txEdit()">${icon('plus')}Add expense</button>`}
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
    <section class="tx-day">
      <header class="tx-day-head">
        <span>${dayName(day)}</span>
        <span class="d-total">${money(dayTotal)}</span>
      </header>
      <div class="list tx-list">
        ${list.map(row).join('')}
      </div>
    </section>`;
  }).join('');
}

function row(t) {
  const flash = t.id && t.id === flashId ? ' tx-flash' : '';
  return `
  <div class="item tap tx-row${t.reviewed ? '' : ' tx-unreviewed'}${flash}" role="button" tabindex="0"
       id="tx-${esc(t.id)}" onclick="txEdit('${esc(t.id)}')" onkeydown="if(event.key==='Enter')this.click()">
    ${merchantIcon(t)}
    <div class="item-main">
      <div class="item-title tx-name"><span class="t">${esc(displayName(t))}</span>${t.reviewed ? '' : '<span class="tx-dot" title="Not reviewed"></span>'}</div>
      <div class="item-sub tx-meta"><span>${timeLabel(t.postedAt)}</span>${accountChip(t)}${catChip(t)}</div>
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

/** The review count, on both the sidebar and the phone's tab bar. */
export function updateNavBadge(rows) {
  const n = unreviewedCount(rows ?? currentRows);
  document.querySelectorAll('#nav button[data-view="transactions"], #tabbar button[data-view="transactions"]')
    .forEach((btn) => {
      let b = btn.querySelector('.badge');
      if (!n) { b?.remove(); return; }
      if (!b) { b = document.createElement('span'); b.className = 'badge'; btn.appendChild(b); }
      b.textContent = String(n);
    });
}

/* ------------------------------------------------------------- editing */

/**
 * The row being edited. The dashboard opens charges from its recent list
 * before this view has ever been drawn, so any month already loaded counts.
 */
export function findRow(id) {
  return currentRows.find((t) => t.id === id) || findCached(id) || null;
}

export function blankTx(monthKey) {
  // Default to today when the visible month is the current one, else the 1st,
  // so a manual entry never silently lands in a month you are not looking at.
  //
  // Today is the Costa Rica day, not the UTC one. Slicing an ISO string dates
  // anything entered after 6pm as tomorrow — and on the last evening of a
  // month, into the next month, where it is saved but invisible.
  const today = dayKey(new Date());
  const thisMonth = crMonth(new Date()) === monthKey;
  const date = thisMonth ? today : `${monthKey}-01`;
  return {
    id: null,
    extId: `manual:${uid()}${Date.now().toString(36)}`,
    kind: 'expense',
    postedAt: crNoon(date),
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
