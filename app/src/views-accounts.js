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
import { icon, accountIcon, cardThumb, merchantIcon, bankOf, networkMark, cardArt } from './icons.js';
import { crShortDate } from './cr-date.js';

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
  if (!b.hasSnapshot) return '<span class="pill neutral">never set</span>';
  if (b.stale) return `<span class="pill warn">${icon('clock')}last set ${esc(crShortDate(b.snapshotDate))}</span>`;
  return `<span>as of ${esc(crShortDate(b.snapshotDate))}</span>`;
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

  views.innerHTML = skeleton();

  getRepo().listAccountBalances()
    .then((list) => {
      balances = list;
      loadedFor = monthKey;
      views.innerHTML = shell(list, monthKey);
    })
    .catch((err) => {
      views.innerHTML = `<div class="card empty">
        <div class="empty-ic" style="color:var(--neg);background:color-mix(in srgb,var(--neg) 12%,transparent)">${icon('alert')}</div>
        <h3>Could not load accounts</h3><p>${esc(err.message)}</p></div>`;
    });
}

/** Forces the next render to re-read from the server. */
export function invalidateAccounts() { balances = null; loadedFor = null; }

function skelRows(n) {
  const row = `<div class="skel-row"><div class="skel" style="width:40px;height:40px;border-radius:12px;flex-shrink:0"></div>
    <div class="skel-lines"><div class="skel skel-line" style="width:40%"></div><div class="skel skel-line" style="width:24%"></div></div>
    <div class="skel skel-line" style="width:80px"></div></div>`;
  return row.repeat(n);
}

function skeleton() {
  return `<span class="sr-only">Loading accounts…</span>
    <div class="acct-top" aria-hidden="true">
      <div class="skel" style="height:184px;border-radius:24px"></div>
      <div class="grid"><div class="skel" style="height:84px;border-radius:18px"></div><div class="skel" style="height:84px;border-radius:18px"></div></div>
    </div>
    <div class="section" aria-hidden="true"><div class="list">${skelRows(3)}</div></div>`;
}

function shell(list, monthKey) {
  const saved = totals(list, monthKey, ['savings', 'investment', 'cash']);
  const owed = totals(list, monthKey, ['card'], { sign: -1 });

  return `
    ${summary(saved, owed, monthKey, list)}
    ${savingsSection(list, monthKey)}
    ${cardsSection(list, monthKey)}
    ${workSection()}
  `;
}

function summary(saved, owed, monthKey, list) {
  const net = saved.crc - owed.crc;
  const tile = (label, value, sub, ic, tone) => `
    <section class="card tile">
      <div class="tile-top"><span class="ti tone-${tone}">${icon(ic)}</span><h3>${label}</h3></div>
      <div class="stat">${value}</div>
      <div class="tile-foot">${sub}</div>
    </section>`;

  const unconverted = { ...saved.pending };
  for (const [k, v] of Object.entries(owed.pending)) unconverted[k] = (unconverted[k] || 0) + v;
  const stillPending = Object.entries(unconverted).filter(([, v]) => v !== 0);

  // How much of what you have the cards already spoke for.
  const share = saved.crc > 0 ? Math.min(100, (owed.crc / saved.crc) * 100) : null;
  const personal = list.filter((b) => (b.scope || 'personal') === 'personal');
  const nCards = new Set(personal.filter((b) => b.type === 'card').map((b) => {
    const a = accountById(b.accountId);
    return a?.issuer && a?.last4 ? `${a.issuer}:${a.last4}` : b.accountId;
  })).size;

  return `
  <div class="acct-top">
    <section class="hero">
      <div class="hero-label">${icon('wallet')}Net position</div>
      <div class="hero-value">${money(net)}</div>
      <div class="hero-sub">What is left of your savings and cash once the cards are paid${net < 0 ? ` &nbsp;<span class="pill">${icon('alert')}in the red</span>` : ''}</div>
      ${share == null ? '' : `
      <div class="hero-bar"><i style="width:${share}%"></i></div>
      <div class="hero-sub">The cards take <b>${Math.round(share)}%</b> of what you have</div>`}
      <div class="hero-stats">
        <div><span>Savings & cash accounts</span><b>${list.filter((b) => ['savings', 'investment', 'cash'].includes(b.type)).length}</b></div>
        <div><span>Personal cards</span><b>${nCards}</b></div>
      </div>
    </section>
    <div class="grid">
      ${tile('Saved & cash', money(saved.crc), 'savings, investments, efectivo', 'piggy', 'savings')}
      ${tile('Owed on cards', money(owed.crc), 'personal cards, work excluded', 'card', 'needs')}
    </div>
  </div>
  ${stillPending.length ? `
  <div class="banner tx-pending">
    <span class="banner-ic">${icon('globe')}</span>
    <div class="banner-text">
      <b>${stillPending.map(([c, v]) => fmt(Math.abs(v), c === 'CRC' ? 'CRC' : c)).join(' + ')}</b>
      on foreign-currency accounts
      <div class="muted">Not in the totals above — no rate set for ${esc(monthKey)}</div>
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
  return a?.last4 ? `<span class="card-tag">${cardThumb(a, { size: 'xs' })}card ••${esc(a.last4)}</span>` : '';
}

/** A savings, investment or cash account: tap to record what it holds now. */
function accountRow(b, monthKey) {
  const a = accountById(b.accountId) || { type: b.type, label: b.label };
  const crc = toCrc(b.currentBalance, b.currency, monthKey);
  const secondary = b.currency === 'CRC' || crc == null
    ? ''
    : `<small>≈ ${money(Math.abs(crc))}</small>`;
  const id = esc(b.accountId);

  return `
  <div class="item tap acct-row" role="button" tabindex="0" title="Update the balance"
       onclick="acctUpdate('${id}')" onkeydown="if(event.key==='Enter')this.click()">
    ${accountIcon({ ...a, type: b.type })}
    <div class="item-main">
      <div class="item-title"><span class="t">${esc(b.label)}</span></div>
      <div class="item-sub">${staleLabel(b)}${cardOn(b)}</div>
      ${b.pendingFx
        ? `<div class="acct-warn">${icon('alert')}<span>${b.pendingFx} foreign charge${b.pendingFx === 1 ? '' : 's'}
             not in this balance — no exchange rate on record yet</span></div>`
        : ''}
    </div>
    <div class="item-amt">${fmt(b.currentBalance, b.currency)}${secondary}</div>
    <div class="item-actions">
      <button class="btn ghost sm" onclick="event.stopPropagation();acctUpdate('${id}')">Update</button>
      <button class="iconbtn sm" title="Edit account" aria-label="Edit ${esc(b.label)}"
              onclick="event.stopPropagation();acctEdit('${id}')">${icon('pencil')}</button>
    </div>
  </div>`;
}

function savingsSection(list, monthKey) {
  const rows = list.filter((b) => ['savings', 'investment', 'cash'].includes(b.type));
  return `
  <section class="section">
    <div class="section-head">
      <h3>Savings & cash</h3>
      <button class="btn ghost sm" onclick="acctAdd()">${icon('plus')}Add account</button>
    </div>
    <p class="section-note lead">Yours to keep current: a transfer or a deposit sends no email, so the
      app only knows what you tell it. Tap an account to record what it holds.</p>
    <div class="list">
      ${rows.length
        ? rows.map((b) => accountRow(b, monthKey)).join('')
        : '<div class="list-empty">No savings accounts yet.</div>'}
    </div>
    <p class="section-note" style="margin-top:10px">
      Anything recorded after the date you set is added on top — including card
      spending, where an account has a card. A foreign charge on such a card is
      converted by the bank the moment it lands, so it is counted straight away
      at the month's rate; that figure is a close approximation rather than the
      bank's own.
    </p>
  </section>`;
}

/** "BAC VISA ₡" and "BAC VISA $" are one card with two balances. */
function cardName(label) {
  return String(label || '').replace(/[₡$]/g, '').replace(/\((work|trabajo)\)/i, '')
    .replace(/\s+/g, ' ').trim();
}

/**
 * One card, drawn as a card, with each balance on it. Tapping a balance
 * edits that half of the card.
 */
function walletCard(group, monthKey) {
  group.sort((x, y) => (x.b.currency === 'CRC' ? -1 : y.b.currency === 'CRC' ? 1 : 0));
  const a = group[0].a ?? { label: group[0].b.label, type: 'card' };
  const bank = bankOf(a);
  const work = group.some(({ b }) => b.scope === 'work');

  const balance = ({ b }) => {
    const owed = Math.abs(b.currentBalance);
    const crc = b.currency === 'CRC' ? null : toCrc(owed, b.currency, monthKey);
    const cur = b.currency === 'CRC' ? 'Colones' : b.currency === 'USD' ? 'Dollars' : esc(b.currency);
    return `<button type="button" class="pcard-bal${owed ? '' : ' zero'}" onclick="acctEdit('${esc(b.accountId)}')"
        aria-label="${esc(b.label)}: ${fmt(owed, b.currency)} owed. Edit">
      <span>${cur}</span>
      <b>${fmt(owed, b.currency)}</b>
      ${b.currency !== 'CRC' && owed ? `<small>${crc == null ? 'not converted' : `≈ ${money(crc)}`}</small>` : ''}
    </button>`;
  };

  return `
  <div class="pcard ${cardArt(a)}">
    <div class="pcard-top">
      <div>
        <div class="pcard-name">${esc(cardName(group[0].b.label))}</div>
        <span class="pcard-bank">${esc(bank?.name || a.institution || 'Card')}</span>
      </div>
      ${networkMark(a.brand) || (bank ? `<span class="nw nw-mono">${bank.mono}</span>` : '')}
    </div>
    <div class="pcard-bals">${group.map(balance).join('')}</div>
    <div class="pcard-foot">
      <span class="pcard-num">•••• ${esc(a.last4 || '')}</span>
      ${work ? `<span class="pcard-tag">${icon('briefcase')}Company card</span>` : ''}
    </div>
  </div>`;
}

function cardsSection(list, monthKey) {
  const rows = list.filter((b) => b.type === 'card');
  if (!rows.length) return '';
  // A colón and a dollar balance that share a number are one physical card.
  const groups = new Map();
  for (const b of rows) {
    const a = accountById(b.accountId);
    const key = a?.issuer && a?.last4 ? `${a.issuer}:${a.last4}` : b.accountId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ b, a });
  }
  return `
  <section class="section">
    <div class="section-head"><h3>Cards</h3></div>
    <p class="section-note lead">Worked out from your transactions, so they move on their own. Each card
      settles its colón and dollar balances separately — tap one to edit it.</p>
    <div class="wallet">${[...groups.values()].map((g) => walletCard(g, monthKey)).join('')}</div>
  </section>`;
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
  const head = (extra = '') => `
    <div class="section-head">
      <h3>Work — owed to you</h3>
      ${extra}
    </div>
    <p class="section-note lead">Work spending you paid for yourself, on any card and from any month —
      reimbursement usually arrives later than the charge. Mark a charge as Work on the
      Activity tab and it appears here.</p>`;

  if (loading) {
    return `<section class="section">${head()}<div class="list">${skelRows(2)}</div></section>`;
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
  <section class="section">
    ${head(owed.length ? `<span class="work-total">${esc(amounts)} <span class="muted" style="font-weight:500">outstanding</span></span>` : '')}

    ${owed.length ? `
    <div class="list">
      <div class="work-head">
        <label class="tx-check">
          <input type="checkbox" id="work_all" onchange="acctSelectAllWork(this.checked)"
                 ${allSelected(owed) ? 'checked' : ''}>
          <span>${selectedCount() ? `${selectedCount()} selected` : 'Select all'}</span>
        </label>
        <button class="btn sm" ${selectedCount() ? '' : 'disabled'}
                onclick="acctSettleSelected()">${icon('check')}Mark reimbursed</button>
      </div>
      ${owed.map(workRow).join('')}
    </div>` : `
    <div class="card empty" style="padding:28px 20px">
      <div class="empty-ic" style="color:var(--pos);background:color-mix(in srgb,var(--pos-mark) 14%,transparent)">${icon('check-circle')}</div>
      <h3>Nothing owed to you</h3>
      <p style="margin-bottom:0">Work expenses you pay for yourself show up here.</p>
    </div>`}

    ${settled.length ? `
    <details class="work-settled">
      <summary>${icon('chevron-right')}${settled.length} already reimbursed</summary>
      <div class="list">
        ${settled.slice(0, 40).map(workRow).join('')}
      </div>
    </details>` : ''}

    ${companyPaid.length ? `
    <details class="work-settled">
      <summary>${icon('chevron-right')}${companyPaid.length} paid by the company</summary>
      <p class="section-note" style="margin:0 0 10px">
        Charges on the BNCR card. The company pays that card directly, so these
        never come out of your pocket and there is nothing to claim back. They
        are kept out of your personal spending and listed here for reference.
      </p>
      <div class="list">
        ${companyPaid.slice(0, 40).map(workRow).join('')}
      </div>
    </details>` : ''}
  </section>`;
}

function workRow(t) {
  const done = isReimbursed(t);
  // dayKey, not a slice of the timestamp: Postgres returns UTC, so an evening
  // charge slices to the following date. Same bug the ledger had.
  const when = dayLabel(dayKey(t.postedAt));
  const company = isCompanyPaid(t);
  const acct = accountById(t.accountId);
  const name = t.merchant || t.merchantRaw || '(no merchant)';

  return `
  <div class="item work-row${done || company ? ' work-done' : ''}">
    ${done || company ? '' : `<input type="checkbox" class="work-pick" aria-label="Select ${esc(name)}"
            ${selected.has(t.id) ? 'checked' : ''} onchange="acctPickWork('${esc(t.id)}',this.checked)">`}
    ${merchantIcon(t, { size: 'sm' })}
    <div class="item-main">
      <div class="item-title"><span class="t">${esc(name)}</span></div>
      <div class="item-sub">
        ${esc(when)}${acct ? ` · ${esc(acct.label)}` : ''}${t.reimbursement?.on ? ` · reimbursed ${esc(dayLabel(t.reimbursement.on))}` : ''}
      </div>
    </div>
    <div class="item-amt">${fmt(t.amount, t.currency)}</div>
    ${company
      ? '<span class="work-tag">company</span>'
      : done
        ? `<button class="btn ghost sm" onclick="acctUnsettle('${esc(t.id)}')">${icon('undo')}Undo</button>`
        : `<button class="btn soft sm" onclick="acctSettleOne('${esc(t.id)}')">Settle</button>`}
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
