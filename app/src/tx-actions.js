/**
 * Interactions for the transactions view: the edit sheet, filters, saving.
 *
 * Kept out of views-tx.js so the rendering module has no dependency on app.js,
 * which would create an import cycle.
 */
import { openModal, closeModal, toast, render } from './app.js';
import { getAccounts, accountById, matchRule, saveTransaction, removeTransaction, loadMonth, rateFor, setMonthRate } from './tx.js';
import { findRow, blankTx, CATS, esc, updateNavBadge } from './views-tx.js';
import { txFilters } from './views-tx.js';

let editing = null;

export function txSetFilter(key, value) {
  txFilters()[key] = value;
  render();
}

export function txEdit(id) {
  const monthKey = window.__txMonth || new Date().toISOString().slice(0, 7);
  editing = id ? { ...findRow(id) } : blankTx(monthKey);
  if (!editing) { toast('Transaction not found'); return; }
  openModal(sheet(editing));
  wireSheet();
}

function sheet(t) {
  const accs = getAccounts();
  const isNew = !t.id;
  const date = String(t.postedAt).slice(0, 10);

  return `
    <h3>${isNew ? 'Add expense' : 'Edit transaction'}</h3>
    ${t.source === 'email' ? `<p class="muted" style="font-size:12px;margin:-6px 0 14px">
      From your bank email · ${esc(t.merchantRaw || '')}
      ${t.authCode ? ` · auth ${esc(t.authCode)}` : ''}</p>` : ''}

    <div class="field"><label>Description</label>
      <input class="inp" id="tx_name" value="${esc(t.merchant || t.merchantRaw || '')}"
             placeholder="e.g. Auto Mercado"></div>

    <div class="tx-2col">
      <div class="field"><label>Amount</label>
        <input class="inp" id="tx_amount" type="number" step="0.01"
               value="${t.amount || ''}" placeholder="0"></div>
      <div class="field"><label>Currency</label>
        <select class="inp" id="tx_currency">
          <option value="CRC"${t.currency === 'CRC' ? ' selected' : ''}>CRC</option>
          <option value="USD"${t.currency === 'USD' ? ' selected' : ''}>USD</option>
        </select></div>
    </div>

    <div class="muted tx-fx-row" style="font-size:12px;margin:-6px 0 14px;line-height:1.5"
         ${t.currency === 'CRC' ? 'hidden' : ''}>
      Foreign charges sit on that card's own balance. They convert at the
      month's rate, set once from the transactions list.
    </div>

    <div class="tx-2col">
      <div class="field"><label>Date</label>
        <input class="inp" id="tx_date" type="date" value="${date}"></div>
      <div class="field"><label>Account</label>
        <select class="inp" id="tx_account">
          <option value="">—</option>
          ${accs.map((a) => `<option value="${esc(a.id)}"${t.accountId === a.id ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}
        </select></div>
    </div>

    <div class="tx-2col">
      <div class="field"><label>Category</label>
        <select class="inp" id="tx_cat">
          <option value="">Unbudgeted</option>
          ${CATS.map(([k, l]) => `<option value="${k}"${t.cat === k ? ' selected' : ''}>${l}</option>`).join('')}
        </select></div>
      <div class="field"><label>Scope</label>
        <select class="inp" id="tx_scope">
          <option value="personal"${t.scope === 'personal' ? ' selected' : ''}>Personal</option>
          <option value="work"${t.scope === 'work' ? ' selected' : ''}>Work (reimbursable)</option>
        </select></div>
    </div>

    <div class="field"><label>Note (optional)</label>
      <input class="inp" id="tx_note" value="${esc(t.note || '')}"></div>

    ${t.source === 'email' && !t.reviewed
      ? `<label class="tx-check" style="margin-bottom:12px">
           <input type="checkbox" id="tx_rule" checked> Remember this merchant for next time
         </label>` : ''}

    <div class="actions">
      ${t.id ? `<button class="btn ghost danger" onclick="txDelete()">Delete</button>` : '<span></span>'}
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="tx_save">Save</button>
    </div>`;
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
    postedAt: `${val('tx_date')}T12:00:00-06:00`,
    accountId: val('tx_account') || null,
    cat: val('tx_cat') || null,
    scope: val('tx_scope') || 'personal',
    note: val('tx_note').trim() || null,
    reviewed: true,
  };

  // A transaction on the work card is reimbursable by default.
  if (t.scope === 'work' && !t.reimbursement) {
    t.reimbursement = { status: 'pending' };
  } else if (t.scope === 'personal') {
    t.reimbursement = null;
  }

  const btn = document.getElementById('tx_save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    await saveTransaction(t);
    const month = String(t.postedAt).slice(0, 7);
    await loadMonth(month, { force: true });
    closeModal();
    render();
    toast(editing.id ? 'Transaction updated' : 'Transaction added');
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
    await loadMonth(String(editing.postedAt).slice(0, 7), { force: true });
    closeModal();
    render();
    toast('Transaction deleted');
  } catch (err) {
    toast(`Could not delete: ${err.message}`);
  }
}


/* ------------------------------------------------ monthly exchange rate */

export function txRateModal() {
  const month = window.__txMonth || new Date().toISOString().slice(0, 7);
  const current = rateFor(month, 'USD');

  openModal(`
    <h3>Exchange rate for ${esc(month)}</h3>
    <p class="muted" style="font-size:13px;margin:-4px 0 16px;line-height:1.55">
      Colones per US dollar, as the dollar balance was actually settled.
      Every USD charge dated ${esc(month)} is converted at this rate — nothing
      is converted until you set it.
    </p>
    <div class="field"><label>₡ per $1</label>
      <input class="inp" id="fx_rate" type="number" step="0.01"
             value="${current ?? ''}" placeholder="e.g. 449.49" autofocus></div>
    <div class="actions">
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
      render();
      toast(`Rate for ${month} set to ₡${rate}`);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Save';
      toast(`Could not save: ${err.message}`);
    }
  });
}
