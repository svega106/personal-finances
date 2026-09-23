/**
 * The accounts view: what you have, and what you owe.
 *
 * Two kinds of account meet here. Cards are driven by transactions — their
 * balance is derived, and the bank emails every change. Savings and cash are
 * not: nothing notifies the app when a savings balance moves, so the number
 * comes from a snapshot you enter by hand, and the app adds any transactions
 * recorded since. That asymmetry is the reason this view exists.
 *
 * Rendering is async because balances come from the server, so this paints a
 * skeleton first and fills it in, exactly as the transactions view does.
 */
import { money } from './state.js';
import { getRepo } from './repo.js';
import { rateFor, accountById } from './tx.js';
import { esc, dayKey, dayLabel } from './views-tx.js';
import { workFor, splitWork, totalByCurrency, isReimbursed, isCompanyPaid } from './work.js';

/**
 * Lets the actions module force a repaint once a settle has landed. Declared
 * up here rather than beside its use, so it cannot be read before assignment.
 */
let rerender = () => {};
export function onWorkLoaded(fn) { rerender = fn; }

let balances = null;
let loadedFor = null;

export function cachedBalances() { return balances; }

/** Snapshots older than this read as "check me" rather than fact. */
function staleLabel(b) {
  if (!b.hasSnapshot) return '<span class="acct-flag acct-never">never set</span>';
  if (b.stale) return `<span class="acct-flag acct-stale">last set ${esc(b.snapshotDate)}</span>`;
  return `<span class="muted acct-when">as of ${esc(b.snapshotDate)}</span>`;
}

function fmt(amount, currency) {
  if (currency === 'CRC') return money(amount);
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

/**
 * Dollar balances are settled at the month's rate, like every other foreign
 * amount in the app. With no rate set they stay out of the colón total rather
 * than being folded in at a guess.
 */
function toCrc(amount, currency, monthKey) {
  if (currency === 'CRC') return amount;
  const r = rateFor(monthKey, currency);
  return r == null ? null : amount * r;
}

/**
 * Sums a group of accounts into colones.
 *
 * Two things this has to get right. Card balances come out of the view
 * negative, because every charge subtracts — "owed" is their magnitude, so
 * `sign` flips them back. And work accounts are money that comes back, so
 * they never count towards a personal total; they are reported on their own.
 */
function totals(list, monthKey, kinds, { sign = 1, scope = 'personal' } = {}) {
  let crc = 0;
  const pending = {};
  let pendingCount = 0;
  for (const b of list) {
    if (!kinds.includes(b.type)) continue;
    if (scope && b.scope && b.scope !== scope) continue;
    const v = toCrc(b.currentBalance, b.currency, monthKey);
    if (v == null) {
      pending[b.currency] = (pending[b.currency] || 0) + b.currentBalance * sign;
      pendingCount += 1;
    } else {
      crc += v * sign;
    }
  }
  return { crc, pending, pendingCount };
}

/* ----------------------------------------------------------------- view */

export function renderAccounts(views, monthKey) {
  if (balances && loadedFor === monthKey) {
    views.innerHTML = shell(balances, monthKey);
    return;
  }

  views.innerHTML = `<div class="card"><p class="muted" style="font-size:13px">Loading accounts…</p></div>`;

  getRepo().listAccountBalances()
    .then((list) => {
      balances = list;
      loadedFor = monthKey;
      views.innerHTML = shell(list, monthKey);
    })
    .catch((err) => {
      views.innerHTML = `<div class="card"><h3>Could not load accounts</h3>
        <p class="muted" style="font-size:13px">${esc(err.message)}</p></div>`;
    });
}

/** Forces the next render to re-read from the server. */
export function invalidateAccounts() { balances = null; loadedFor = null; }

function shell(list, monthKey) {
  const saved = totals(list, monthKey, ['savings', 'investment', 'cash']);
  const owed = totals(list, monthKey, ['card'], { sign: -1 });

  return `
    ${summary(saved, owed, monthKey)}
    ${savingsSection(list, monthKey)}
    ${cardsSection(list, monthKey)}
    ${workSection()}
  `;
}

function summary(saved, owed, monthKey) {
  const net = saved.crc - owed.crc;
  const card = (label, value, sub, colour) => `
    <div class="card">
      <h3>${label}</h3>
      <div class="stat"${colour ? ` style="color:${colour}"` : ''}>${value}</div>
      <div class="muted" style="font-size:12px;margin-top:3px">${sub}</div>
    </div>`;

  const unconverted = { ...saved.pending };
  for (const [k, v] of Object.entries(owed.pending)) unconverted[k] = (unconverted[k] || 0) + v;
  const stillPending = Object.entries(unconverted).filter(([, v]) => v !== 0);

  return `
  <div class="grid g3" style="margin-bottom:4px">
    ${card('Saved & cash', money(saved.crc), 'savings, investments, efectivo')}
    ${card('Owed on cards', money(owed.crc), 'personal cards, work excluded',
           owed.crc > 0 ? 'var(--need)' : null)}
    ${card('Net position', money(net), 'what is left after the cards',
           net < 0 ? 'var(--bad)' : 'var(--good)')}
  </div>
  ${stillPending.length ? `
  <div class="card tx-pending">
    <div>
      <b>${stillPending.map(([c, v]) => `${c === 'USD' ? '$' : c + ' '}${Math.abs(v).toFixed(2)}`).join(' + ')}</b>
      on foreign-currency accounts
      <span class="muted">· not in the totals above, no rate set for ${esc(monthKey)}</span>
    </div>
    <button class="btn ghost sm" onclick="txRateModal()">Set this month's rate</button>
  </div>` : ''}`;
}

/**
 * A debit card is not an account of its own — it spends from one. Saying so
 * on the row is the difference between a balance that looks wrong and one
 * that explains itself.
 */
function cardOn(b) {
  const a = accountById(b.accountId);
  return a?.last4 ? `<span class="acct-card">card ····${esc(a.last4)}</span>` : '';
}

function accountRow(b, monthKey, { owed = false } = {}) {
  const shown = owed ? Math.abs(b.currentBalance) : b.currentBalance;
  const crc = toCrc(b.currentBalance, b.currency, monthKey);
  const secondary = b.currency === 'CRC' || crc == null
    ? ''
    : `<span class="acct-crc">${money(Math.abs(crc))}</span>`;

  return `
  <div class="acct-row">
    <div class="acct-main">
      <div class="acct-name">${esc(b.label)}</div>
      <div class="acct-meta">${owed
        ? '<span class="muted">from your transactions</span>'
        : `${staleLabel(b)}${cardOn(b)}`}</div>
      ${!owed && b.pendingFx
        ? `<div class="acct-warn">${b.pendingFx} foreign charge${b.pendingFx === 1 ? '' : 's'}
             not in this balance — no exchange rate on record yet</div>`
        : ''}
    </div>
    <div class="acct-amt">
      <div>${fmt(shown, b.currency)}${secondary}</div>
    </div>
    ${owed ? '' : `<button class="btn ghost sm" onclick="acctUpdate('${esc(b.accountId)}')">Update</button>`}
  </div>`;
}

function savingsSection(list, monthKey) {
  const rows = list.filter((b) => ['savings', 'investment', 'cash'].includes(b.type));
  return `
  <div class="section-title spread" style="margin-top:22px">
    <span>Savings &amp; cash</span>
    <button class="btn ghost sm" onclick="acctAdd()">+ Add account</button>
  </div>
  <p class="muted acct-note">
    Yours to keep current: a transfer or a deposit sends no email, so the app
    only knows what you tell it. Anything recorded after the date you set is
    added on top — including card spending, where an account has a card. A
    foreign charge on such a card is converted by the bank the moment it
    lands, so it is counted straight away at the month's rate; that figure is
    a close approximation rather than the bank's own.
  </p>
  <div class="card acct-list">
    ${rows.length
      ? rows.map((b) => accountRow(b, monthKey)).join('')
      : '<div class="muted" style="padding:18px;text-align:center;font-size:13px">No savings accounts yet.</div>'}
  </div>`;
}

function cardsSection(list, monthKey) {
  const rows = list.filter((b) => b.type === 'card');
  return `
  <div class="section-title" style="margin-top:26px"><span>Cards</span></div>
  <p class="muted acct-note">
    Card balances are worked out from your transactions, so they move on their
    own. Each card settles its colón and dollar balances separately.
  </p>
  <div class="card acct-list">
    ${rows.map((b) => accountRow(b, monthKey, { owed: true })).join('')}
  </div>`;
}

/**
 * Work charges are spending you expect back, so they are kept out of every
 * personal total elsewhere. This is where they are chased down.
 *
 * Not limited to the month on screen: reimbursement usually lands a month or
 * two after the charge, and having to navigate back to September to settle
 * something you were paid for in October is how a list like this stops being
 * used.
 */
function workSection() {
  const { rows, loading } = workFor(rerender);
  if (loading) {
    return `
    <div class="section-title" style="margin-top:26px"><span>Work — reimbursable</span></div>
    <div class="card"><p class="muted" style="font-size:13px">Loading work charges…</p></div>`;
  }

  const { owed, settled, companyPaid } = splitWork(rows);
  const total = totalByCurrency(owed);
  // Colones and dollars are never added together: the two balances settle
  // separately, and what work owes you has nothing to do with the month's rate.
  const amounts = Object.entries(total)
    .sort(([a], [b]) => (a === 'CRC' ? -1 : b === 'CRC' ? 1 : a.localeCompare(b)))
    .map(([cur, v]) => fmt(v, cur))
    .join(' + ');

  return `
  <div class="section-title spread" style="margin-top:26px">
    <span>Work — owed to you</span>
    ${owed.length ? `<span class="muted" style="font-size:13px;font-weight:500">
      ${esc(amounts)} outstanding</span>` : ''}
  </div>
  <p class="muted acct-note">
    Work spending you paid for yourself, on any card and from any month —
    reimbursement usually arrives later than the charge. Mark a charge as Work
    on the Transactions tab and it appears here.
  </p>

  ${owed.length ? `
  <div class="card acct-list">
    <div class="work-head">
      <label class="tx-check">
        <input type="checkbox" id="work_all" onchange="acctSelectAllWork(this.checked)"
               ${allSelected(owed) ? 'checked' : ''}>
        <span>${selectedCount() ? `${selectedCount()} selected` : 'Select all'}</span>
      </label>
      <button class="btn sm" ${selectedCount() ? '' : 'disabled'}
              onclick="acctSettleSelected()">Mark reimbursed</button>
    </div>
    ${owed.map(workRow).join('')}
  </div>` : `
  <div class="card" style="text-align:center;padding:30px 20px">
    <p class="muted" style="font-size:13px;margin:0">
      Nothing owed to you. Work expenses you pay for yourself show up here.</p>
  </div>`}

  ${settled.length ? `
  <details class="work-settled">
    <summary>${settled.length} already reimbursed</summary>
    <div class="card acct-list">
      ${settled.slice(0, 40).map(workRow).join('')}
    </div>
  </details>` : ''}

  ${companyPaid.length ? `
  <details class="work-settled">
    <summary>${companyPaid.length} paid by the company</summary>
    <p class="muted acct-note" style="margin-top:8px">
      Charges on the BNCR card. The company pays that card directly, so these
      never come out of your pocket and there is nothing to claim back. They
      are kept out of your personal spending and listed here for reference.
    </p>
    <div class="card acct-list">
      ${companyPaid.slice(0, 40).map(workRow).join('')}
    </div>
  </details>` : ''}`;
}

function workRow(t) {
  const done = isReimbursed(t);
  // dayKey, not a slice of the timestamp: Postgres returns UTC, so an evening
  // charge slices to the following date. Same bug the ledger had.
  const when = dayLabel(dayKey(t.postedAt));
  const company = isCompanyPaid(t);
  const acct = accountById(t.accountId);

  return `
  <div class="acct-row work-row${done || company ? ' work-done' : ''}">
    ${done || company ? '' : `<input type="checkbox" class="work-pick" ${selected.has(t.id) ? 'checked' : ''}
            onchange="acctPickWork('${esc(t.id)}',this.checked)">`}
    <div class="acct-main">
      <div class="acct-name">${esc(t.merchant || t.merchantRaw || '(no merchant)')}</div>
      <div class="acct-meta muted">
        ${esc(when)}${acct ? ` · ${esc(acct.label)}` : ''}${t.reimbursement?.on ? ` · reimbursed ${esc(dayLabel(t.reimbursement.on))}` : ''}
      </div>
    </div>
    <div class="acct-amt"><div>${fmt(t.amount, t.currency)}</div></div>
    ${company
      ? '<span class="work-tag">company</span>'
      : done
        ? `<button class="btn ghost sm" onclick="acctUnsettle('${esc(t.id)}')">Undo</button>`
        : `<button class="btn ghost sm" onclick="acctSettleOne('${esc(t.id)}')">Settle</button>`}
  </div>`;
}

/* ------------------------------------------------------------ selection */

const selected = new Set();

export function workSelected() { return selected; }
export function selectedCount() { return selected.size; }

function allSelected(owed) {
  return owed.length > 0 && owed.every((t) => selected.has(t.id));
}

/** Only outstanding charges can be picked; a settled one has nothing to settle. */
export function setAllWorkSelected(on) {
  selected.clear();
  if (on) {
    // Only what is actually owed: a company-paid charge has nothing to settle.
    const { owed } = splitWork(cachedWorkRows());
    for (const t of owed) selected.add(t.id);
  }
}

export function pickWork(id, on) {
  if (on) selected.add(id); else selected.delete(id);
}

function cachedWorkRows() {
  const { rows } = workFor();
  return rows;
}

/** Selections must not survive the rows they point at. */
export function clearWorkSelection() { selected.clear(); }


