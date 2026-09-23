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
import { cachedBalances, invalidateAccounts, getWorkRows } from './views-accounts.js';

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

export function acctMarkReimbursed() {
  const pending = getWorkRows().filter((t) => t.reimbursement?.status !== 'reimbursed');
  if (!pending.length) { toast('Nothing pending'); return; }

  openModal(`
    <h3>Mark ${pending.length} charge${pending.length === 1 ? '' : 's'} reimbursed</h3>
    <p class="muted" style="font-size:13px;margin:-4px 0 18px;line-height:1.55">
      This records that the money came back for every work charge still
      pending this month. The charges stay in your history — only their
      status changes.
    </p>
    <div class="field"><label>Reimbursed on</label>
      <input class="inp" id="rb_date" type="date" value="${today()}"></div>
    <div class="actions">
      <span></span>
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="rb_save">Confirm</button>
    </div>`);

  document.getElementById('rb_save')?.addEventListener('click', async () => {
    const on = val('rb_date') || today();
    const btn = document.getElementById('rb_save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      // One at a time: a partial failure should leave the rest correct rather
      // than rolling back charges that were already settled.
      for (const t of pending) {
        await saveTransaction({ ...t, reimbursement: { status: 'reimbursed', on } });
      }
      const month = window.__txMonth || new Date().toISOString().slice(0, 7);
      await loadMonth(month, { force: true });
      invalidateAccounts();
      closeModal();
      render();
      toast(`${pending.length} charge${pending.length === 1 ? '' : 's'} marked reimbursed`);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Confirm';
      toast(`Could not save: ${err.message}`);
    }
  });
}
