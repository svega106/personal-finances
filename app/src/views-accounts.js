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
import { rateFor, loadMonth } from './tx.js';
import { esc } from './views-tx.js';

let balances = null;
let workRows = [];
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

  Promise.all([getRepo().listAccountBalances(), loadMonth(monthKey)])
    .then(([list, rows]) => {
      balances = list;
      workRows = rows.filter((t) => t.scope === 'work');
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
    ${workSection(monthKey)}
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
      <div class="acct-meta">${owed ? '<span class="muted">from your transactions</span>' : staleLabel(b)}</div>
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
    These balances are yours to keep current — no bank emails when a savings
    balance changes. Anything you record afterwards is added on top.
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
 * personal total elsewhere. This is the one place they are added up.
 */
function workSection(monthKey) {
  const pending = workRows.filter((t) => t.reimbursement?.status !== 'reimbursed');
  const done = workRows.filter((t) => t.reimbursement?.status === 'reimbursed');
  const sum = (rows, cur) => rows
    .filter((t) => t.currency === cur)
    .reduce((s, t) => s + t.amount, 0);

  const amounts = [
    sum(pending, 'CRC') ? money(sum(pending, 'CRC')) : null,
    sum(pending, 'USD') ? `$${sum(pending, 'USD').toFixed(2)}` : null,
  ].filter(Boolean);

  return `
  <div class="section-title" style="margin-top:26px"><span>Work — reimbursable</span></div>
  <p class="muted acct-note">
    Charges on the BNCR card. They are excluded from your personal spending,
    and tracked here until the money comes back.
  </p>
  <div class="card acct-list">
    ${workRows.length ? `
      <div class="acct-row">
        <div class="acct-main">
          <div class="acct-name">Awaiting reimbursement</div>
          <div class="acct-meta muted">${pending.length} charge${pending.length === 1 ? '' : 's'} this month</div>
        </div>
        <div class="acct-amt"><div>${amounts.length ? amounts.join(' + ') : money(0)}</div></div>
      </div>
      ${done.length ? `
      <div class="acct-row">
        <div class="acct-main">
          <div class="acct-name">Already reimbursed</div>
          <div class="acct-meta muted">${done.length} charge${done.length === 1 ? '' : 's'} this month</div>
        </div>
        <div class="acct-amt"><div class="muted">${money(sum(done, 'CRC'))}</div></div>
      </div>` : ''}
      ${pending.length ? `
      <div class="acct-row acct-actions">
        <button class="btn ghost sm" onclick="setView('transactions')">Review them →</button>
        <button class="btn sm" onclick="acctMarkReimbursed()">Mark all reimbursed</button>
      </div>` : ''}
    ` : '<div class="muted" style="padding:18px;text-align:center;font-size:13px">No work charges this month.</div>'}
  </div>`;
}

/**
 * A getter, not the binding itself: an imported `let` is read-only to the
 * importer, and Rollup rejects an assignment to one at build time.
 */
export function getWorkRows() { return workRows; }
