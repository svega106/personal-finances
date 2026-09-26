/**
 * Interactions for the transactions view: the edit sheet, filters, saving.
 *
 * Kept out of views-tx.js so the rendering module has no dependency on app.js,
 * which would create an import cycle.
 */
import { openModal, closeModal, toast, render, getActiveView } from './app.js';
import { getAccounts, accountById, matchRule, saveTransaction, removeTransaction, rateFor, setMonthRate, budgetLines } from './tx.js';
import { getMonth, money, monthLabel } from './state.js';
import { initialReimbursement } from './work.js';
import { findRow, blankTx, CATS, esc, flashRow, onFlashHidden } from './views-tx.js';
import { crDay, crMonth, crNoon } from './cr-date.js';
import { afterLedgerChange } from './refresh.js';
import { txFilters } from './views-tx.js';
import { icon } from './icons.js';

let editing = null;

// A charge can save perfectly and still not appear, because a filter set
// earlier is hiding it. Saying so beats letting it look like a failed save.
onFlashHidden(() => toast('Saved — a filter is hiding it. Clear the filters to see it.'));

export function txSetFilter(key, value) {
  txFilters()[key] = value;
  render();
}

export function txClearFilters() {
  Object.assign(txFilters(), { account: 'all', cat: 'all', unreviewedOnly: false });
  render();
}

export function txEdit(id) {
  const monthKey = window.__txMonth || crMonth(new Date());
  // Spreading a missing row gives `{}`, which is truthy — checked before the
  // copy, or an unknown id opens an empty sheet instead of saying so.
  const row = id ? findRow(id) : null;
  if (id && !row) { toast('Transaction not found'); return; }
  editing = row ? { ...row } : blankTx(monthKey);
  openModal(sheet(editing));
  wireSheet();
}

function sheet(t) {
  const accs = getAccounts();
  const isNew = !t.id;
  // The Costa Rica day, not the UTC one. Slicing the timestamp showed a 9pm
  // charge as tomorrow — and since saving writes this field back, it moved
  // the charge there and replaced the time it happened with noon.
  const date = crDay(t.postedAt);

  return `
    <h3>${isNew ? 'Add expense' : 'Edit transaction'}</h3>
    ${t.source === 'email' ? `<p class="sheet-sub">${icon('mail')}<span>From your bank email · ${esc(t.merchantRaw || '')}${t.authCode ? ` · auth ${esc(t.authCode)}` : ''}</span></p>`
      : isNew ? '<p class="sheet-sub">Cash, a transfer, anything a bank email will not bring in.</p>' : ''}

    <div class="amount-field">
      <select class="amount-cur" id="tx_currency" aria-label="Currency">
        <option value="CRC"${t.currency === 'CRC' ? ' selected' : ''}>₡ CRC</option>
        <option value="USD"${t.currency === 'USD' ? ' selected' : ''}>$ USD</option>
      </select>
      <input class="amount-inp" id="tx_amount" type="number" inputmode="decimal" step="0.01"
             value="${t.amount || ''}" placeholder="0" aria-label="Amount">
    </div>

    <p class="sheet-sub tx-fx-row" style="margin:-6px 0 14px" ${t.currency === 'CRC' ? 'hidden' : ''}>
      ${icon('globe')}<span>Foreign charges sit on that card's own balance. They convert at the
      month's rate, set once from the Activity list.</span>
    </p>

    <div class="field"><label for="tx_name">Description</label>
      <input class="inp" id="tx_name" value="${esc(t.merchant || t.merchantRaw || '')}"
             placeholder="e.g. Auto Mercado" autocomplete="off"></div>

    <div class="tx-2col">
      <div class="field"><label for="tx_date">Date</label>
        <input class="inp" id="tx_date" type="date" value="${date}"></div>
      <div class="field"><label for="tx_account">Account</label>
        <select class="inp" id="tx_account">
          <option value="">—</option>
          ${accs.map((a) => `<option value="${esc(a.id)}"${t.accountId === a.id ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}
        </select></div>
    </div>

    <div class="tx-2col">
      <div class="field"><label for="tx_cat">Category</label>
        <select class="inp" id="tx_cat">
          <option value="">Uncategorized</option>
          ${CATS.map(([k, l]) => `<option value="${k}"${t.cat === k ? ' selected' : ''}>${l}</option>`).join('')}
        </select></div>
      <div class="field"><label for="tx_scope">Scope</label>
        <select class="inp" id="tx_scope">
          <option value="personal"${t.scope === 'personal' ? ' selected' : ''}>Personal</option>
          <option value="work"${t.scope === 'work' ? ' selected' : ''}>Work</option>
        </select></div>
    </div>

    <div class="field"><label for="tx_line">Budget line</label>
      ${lineOptions(t)}
      <div class="field-hint">
        Attach this to a line from the month's plan and it counts against it.
        Left unattached, it still counts towards its category.
      </div></div>

    <div class="field"><label for="tx_note">Note <span class="faint">(optional)</span></label>
      <input class="inp" id="tx_note" value="${esc(t.note || '')}"></div>

    ${t.source === 'email' && !t.reviewed
      ? `<label class="check" style="margin-bottom:6px">
           <input type="checkbox" id="tx_rule" checked> Remember this merchant for next time
         </label>` : ''}

    <div class="actions">
      ${t.id ? `<button class="btn ghost danger" onclick="txDelete()" aria-label="Delete">${icon('trash')}<span class="lbl">Delete</span></button>` : '<span></span>'}
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="tx_save">Save</button>
    </div>`;
}

/**
 * Lines come from the plan for the month the charge is dated in, not the
 * month being viewed — editing a September charge from October must still
 * offer September's plan.
 */
function lineOptions(t) {
  const monthKey = crMonth(t.postedAt);
  const lines = budgetLines(getMonth(monthKey));

  if (!lines.length) {
    return `<select class="inp" id="tx_line" disabled>
      <option>No plan lines for ${esc(monthKey)} yet</option></select>`;
  }

  const GROUPS = [['bills', 'Fixed bills'], ['recurring', 'Recurring'], ['oneTime', 'One-time']];
  const groups = GROUPS.map(([key, label]) => {
    const inGroup = lines.filter((l) => l.group === key);
    if (!inGroup.length) return '';
    return `<optgroup label="${label}">${inGroup.map((l) => `
      <option value="${esc(l.id)}"${t.budgetLineId === l.id ? ' selected' : ''}
              data-cat="${esc(l.cat)}">${esc(l.name)} · ${money(l.amount)}</option>`).join('')}</optgroup>`;
  }).join('');

  return `<select class="inp" id="tx_line">
    <option value=""${t.budgetLineId ? '' : ' selected'}>— not attached —</option>
    ${groups}
  </select>`;
}

function wireSheet() {
  const cur = document.getElementById('tx_currency');
  const acct = document.getElementById('tx_account');
  const fxRow = document.querySelector('.tx-fx-row');
  const syncNote = () => { if (fxRow) fxRow.hidden = cur.value === 'CRC'; };

  cur?.addEventListener('change', syncNote);

  // Each card has a colón account and a dollar account. Choosing one implies
  // the currency, so keep them in step rather than letting them disagree.
  acct?.addEventListener('change', () => {
    const a = getAccounts().find((x) => x.id === acct.value);
    if (a?.currency) { cur.value = a.currency; syncNote(); }
  });

  // A line belongs to a category, so picking one settles the category too
  // rather than letting the two drift apart.
  const line = document.getElementById('tx_line');
  line?.addEventListener('change', () => {
    const cat = line.selectedOptions[0]?.dataset?.cat;
    const catSel = document.getElementById('tx_cat');
    if (cat && catSel) catSel.value = cat;
  });

  document.getElementById('tx_save')?.addEventListener('click', txSave);
}

const val = (id) => document.getElementById(id)?.value ?? '';

export async function txSave() {
  const name = val('tx_name').trim();
  const amount = Number(val('tx_amount')) || 0;
  const currency = val('tx_currency') || 'CRC';

  if (!name) { toast('Give it a description'); return; }
  if (amount <= 0) { toast('Amount must be more than zero'); return; }

  const t = {
    ...editing,
    merchant: name,
    merchantRaw: editing.merchantRaw || name,
    amount,
    currency,
    // Conversion is the month's job, not this row's.
    fxRate: null,
    amountCrc: currency === 'CRC' ? amount : null,
    // The sheet offers a date, not a time. Rewriting an untouched date as
    // noon would throw away the minute the bank recorded — so the instant is
    // only rebuilt when the day actually changed.
    postedAt: editing.postedAt && crDay(editing.postedAt) === val('tx_date')
      ? editing.postedAt
      : crNoon(val('tx_date')),
    accountId: val('tx_account') || null,
    cat: val('tx_cat') || null,
    budgetLineId: val('tx_line') || null,
    scope: val('tx_scope') || 'personal',
    note: val('tx_note').trim() || null,
    reviewed: true,
  };

  // Marking something as work only makes it reimbursable when the money was
  // yours: a charge on the company's own card is theirs to settle.
  if (t.scope === 'work') {
    if (!t.reimbursement) t.reimbursement = initialReimbursement(accountById(t.accountId));
  } else {
    t.reimbursement = null;
  }

  const btn = document.getElementById('tx_save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const saved = await saveTransaction(t);
    const wasEdit = Boolean(editing.id);
    closeModal();
    // Marked before the repaint, so the row is drawn already highlighted. Only
    // on the Activity list: added from anywhere else there is no row to find,
    // and a mark left waiting would flash on some later, unrelated visit.
    if (getActiveView() === 'transactions') flashRow(saved?.id ?? t.id);
    await afterLedgerChange(crMonth(t.postedAt));
    toast(wasEdit ? 'Transaction updated' : 'Transaction added');
  } catch (err) {
    console.error('[tx]', err);
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    toast(`Could not save: ${err.message}`);
  }
}

export async function txDelete() {
  if (!editing?.id) return;
  if (!confirm(`Delete "${editing.merchant || editing.merchantRaw}"?`)) return;
  try {
    await removeTransaction(editing);
    closeModal();
    await afterLedgerChange(crMonth(editing.postedAt));
    toast('Transaction deleted');
  } catch (err) {
    toast(`Could not delete: ${err.message}`);
  }
}


/* ------------------------------------------------ monthly exchange rate */

export function txRateModal() {
  const month = window.__txMonth || crMonth(new Date());
  const current = rateFor(month, 'USD');

  openModal(`
    <h3>Exchange rate for ${esc(monthLabel(month))}</h3>
    <p class="sheet-sub">
      Colones per US dollar, as the dollar balance was actually settled.
      Every USD charge dated in ${esc(monthLabel(month))} is converted at this
      rate — nothing is converted until you set it.
    </p>
    <div class="amount-field">
      <span class="amount-cur" style="display:grid;place-items:center;background:var(--surface);padding:0 12px">₡ per $1</span>
      <input class="amount-inp" id="fx_rate" type="number" inputmode="decimal" step="0.01"
             value="${current ?? ''}" placeholder="449.49" aria-label="Colones per US dollar">
    </div>
    <div class="actions">
      <span></span>
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="fx_save">Save</button>
    </div>`);

  document.getElementById('fx_save')?.addEventListener('click', async () => {
    const rate = Number(document.getElementById('fx_rate').value);
    if (!rate || rate <= 0) { toast('Enter a rate above zero'); return; }
    const btn = document.getElementById('fx_save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await setMonthRate(month, 'USD', rate);
      closeModal();
      // The balances view converts foreign charges in SQL, so a new rate
      // changes every figure on it, not just the transactions list.
      await afterLedgerChange(month);
      toast(`Rate for ${month} set to ₡${rate}`);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Save';
      toast(`Could not save: ${err.message}`);
    }
  });
}
