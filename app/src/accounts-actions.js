/**
 * Interactions for the accounts view: recording a balance, adding an account,
 * settling work charges.
 *
 * Kept out of views-accounts.js so the rendering module has no dependency on
 * app.js, which would create an import cycle.
 */
import { openModal, closeModal, toast, render } from './app.js';
import { getRepo } from './repo.js';
import { getAccounts, loadMonth, loadReference, saveTransaction } from './tx.js';
import { esc } from './views-tx.js';
import {
  cachedBalances, invalidateAccounts, onWorkLoaded,
  workSelected, clearWorkSelection, setAllWorkSelected, pickWork,
} from './views-accounts.js';
import { loadWork, invalidateWork, cachedWork, settle, unsettle } from './work.js';

const today = () => new Date().toISOString().slice(0, 10);
const val = (id) => document.getElementById(id)?.value ?? '';

function findBalance(accountId) {
  return (cachedBalances() ?? []).find((b) => b.accountId === accountId) || null;
}

/* ------------------------------------------------------ record a balance */

export function acctUpdate(accountId) {
  const b = findBalance(accountId);
  if (!b) { toast('Account not found'); return; }

  openModal(`
    <h3>Balance for ${esc(b.label)}</h3>
    <p class="muted" style="font-size:13px;margin:-4px 0 16px;line-height:1.55">
      Enter what the account actually holds right now. Anything you record
      after this date is added on top, so you only need to do this when the
      two have drifted apart.
    </p>

    <div class="tx-2col">
      <div class="field"><label>Balance (${esc(b.currency)})</label>
        <input class="inp" id="bal_amount" type="number" step="0.01"
               value="${b.hasSnapshot ? b.currentBalance : ''}"
               placeholder="0" autofocus></div>
      <div class="field"><label>As of</label>
        <input class="inp" id="bal_date" type="date" value="${today()}"></div>
    </div>

    <div class="field"><label>Note (optional)</label>
      <input class="inp" id="bal_note" placeholder="e.g. after the December bonus"></div>

    <div class="actions">
      <span></span>
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="bal_save">Save</button>
    </div>`);

  document.getElementById('bal_save')?.addEventListener('click', async () => {
    const balance = Number(val('bal_amount'));
    if (!Number.isFinite(balance)) { toast('Enter a balance'); return; }
    const asOf = val('bal_date') || today();

    const btn = document.getElementById('bal_save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await getRepo().saveSnapshot({
        accountId, asOf, balance, currency: b.currency, note: val('bal_note').trim(),
      });
      invalidateAccounts();
      closeModal();
      render();
      toast(`${b.label} set to ${b.currency === 'CRC' ? '₡' : '$'}${balance.toLocaleString()}`);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Save';
      toast(`Could not save: ${err.message}`);
    }
  });
}

/* --------------------------------------------------------- add an account */

export function acctAdd() {
  openModal(`
    <h3>Add an account</h3>
    <p class="muted" style="font-size:13px;margin:-4px 0 16px;line-height:1.55">
      For savings, investments or cash you keep track of yourself. Cards come
      from your bank emails and do not need to be added here.
    </p>

    <div class="field"><label>Name</label>
      <input class="inp" id="acc_label" placeholder="e.g. Ahorros BAC" autofocus></div>

    <div class="tx-2col">
      <div class="field"><label>Kind</label>
        <select class="inp" id="acc_type">
          <option value="savings">Savings</option>
          <option value="investment">Investment</option>
          <option value="cash">Cash</option>
        </select></div>
      <div class="field"><label>Currency</label>
        <select class="inp" id="acc_currency">
          <option value="CRC">CRC</option>
          <option value="USD">USD</option>
        </select></div>
    </div>

    <div class="field"><label>Bank (optional)</label>
      <input class="inp" id="acc_inst" placeholder="e.g. BAC Credomatic"></div>

    <div class="actions">
      <span></span>
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="acc_save">Add</button>
    </div>`);

  document.getElementById('acc_save')?.addEventListener('click', async () => {
    const label = val('acc_label').trim();
    if (!label) { toast('Give the account a name'); return; }
    if (getAccounts().some((a) => a.label.toLowerCase() === label.toLowerCase())) {
      toast('An account with that name already exists'); return;
    }

    const btn = document.getElementById('acc_save');
    btn.disabled = true; btn.textContent = 'Adding…';
    try {
      await getRepo().upsertAccount({
        label,
        type: val('acc_type'),
        currency: val('acc_currency'),
        institution: val('acc_inst').trim() || null,
      });
      // The account list is loaded once at boot, so it has to be refreshed
      // before the new account can be picked on a transaction.
      await loadReference();
      invalidateAccounts();
      closeModal();
      render();
      toast(`${label} added`);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Add';
      toast(`Could not add: ${err.message}`);
    }
  });
}

/* ------------------------------------------------------ work reimbursement */

// Repaint the accounts view when work charges finish loading.
onWorkLoaded(() => render());

function findWork(id) {
  return (cachedWork() ?? []).find((t) => t.id === id) || null;
}

export function acctPickWork(id, on) {
  pickWork(id, on);
  render();
}

export function acctSelectAllWork(on) {
  setAllWorkSelected(on);
  render();
}

/** One charge, one click — the common case deserves no dialog. */
export async function acctSettleOne(id) {
  const t = findWork(id);
  if (!t) { toast('Charge not found'); return; }
  await applySettle([t], today());
}

/**
 * Several at once, under a single date, because work pays for a batch of
 * charges in one transfer.
 */
export function acctSettleSelected() {
  const ids = [...workSelected()];
  const rows = ids.map(findWork).filter(Boolean);
  if (!rows.length) { toast('Nothing selected'); return; }

  openModal(`
    <h3>Mark ${rows.length} charge${rows.length === 1 ? '' : 's'} reimbursed</h3>
    <p class="muted" style="font-size:13px;margin:-4px 0 16px;line-height:1.55">
      The charges stay in your history — only their status changes. You can
      undo any of them afterwards.
    </p>
    <div class="field"><label>Reimbursed on</label>
      <input class="inp" id="rb_date" type="date" value="${today()}"></div>
    <div class="actions">
      <span></span>
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="rb_save">Confirm</button>
    </div>`);

  document.getElementById('rb_save')?.addEventListener('click', async () => {
    const btn = document.getElementById('rb_save');
    btn.disabled = true; btn.textContent = 'Saving…';
    const ok = await applySettle(rows, val('rb_date') || today(), { silent: true });
    if (ok) { closeModal(); toast(`${rows.length} marked reimbursed`); }
    else { btn.disabled = false; btn.textContent = 'Confirm'; }
  });
}

export async function acctUnsettle(id) {
  const t = findWork(id);
  if (!t) { toast('Charge not found'); return; }
  try {
    await saveTransaction(unsettle(t));
    await refreshWork();
    toast('Moved back to outstanding');
  } catch (err) {
    toast(`Could not undo: ${err.message}`);
  }
}

/**
 * Saves one at a time on purpose: a partial failure should leave the charges
 * that did settle settled, rather than rolling back money that really did
 * come back.
 */
async function applySettle(rows, on, { silent = false } = {}) {
  const failed = [];
  for (const t of rows) {
    try {
      await saveTransaction(settle(t, on));
    } catch (err) {
      failed.push(`${t.merchant || t.merchantRaw}: ${err.message}`);
    }
  }

  clearWorkSelection();
  await refreshWork();

  if (failed.length) {
    toast(`${failed.length} could not be saved — ${failed[0]}`);
    return false;
  }
  if (!silent) toast('Marked reimbursed');
  return true;
}

async function refreshWork() {
  invalidateWork();
  invalidateAccounts();
  await loadWork({ force: true });
  render();
}
