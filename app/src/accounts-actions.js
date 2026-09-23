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

/* ------------------------------------------------- adding and editing accounts */

/**
 * One form for both. Adding and editing an account differ only in whether
 * there is something to archive and whether the currency is still free to
 * choose, so keeping them apart would mean two forms drifting out of step.
 */
function accountForm(a) {
  const isNew = !a?.id;
  const type = a?.type || 'savings';
  const isCard = type === 'card';

  return `
    <h3>${isNew ? 'Add an account' : esc(a.label)}</h3>
    <p class="muted" style="font-size:13px;margin:-4px 0 16px;line-height:1.55">
      ${isNew
        ? 'For savings, investments or cash you keep track of yourself.'
        : 'Renaming is safe at any time — transactions follow the account, not its name.'}
    </p>

    <div class="field"><label>Name</label>
      <input class="inp" id="acc_label" value="${esc(a?.label ?? '')}"
             placeholder="e.g. Ahorros BAC"${isNew ? ' autofocus' : ''}></div>

    <div class="tx-2col">
      <div class="field"><label>Kind</label>
        <select class="inp" id="acc_type"${isCard ? ' disabled' : ''}>
          ${isCard ? '<option value="card" selected>Card</option>' : ''}
          <option value="savings"${type === 'savings' ? ' selected' : ''}>Savings</option>
          <option value="investment"${type === 'investment' ? ' selected' : ''}>Investment</option>
          <option value="cash"${type === 'cash' ? ' selected' : ''}>Cash</option>
        </select></div>
      <div class="field"><label>Currency</label>
        <select class="inp" id="acc_currency"${isNew ? '' : ' disabled'}>
          <option value="CRC"${(a?.currency ?? 'CRC') === 'CRC' ? ' selected' : ''}>CRC</option>
          <option value="USD"${a?.currency === 'USD' ? ' selected' : ''}>USD</option>
        </select></div>
    </div>
    ${isNew ? '' : `<p class="muted" style="font-size:11.5px;margin:-8px 0 14px">
      Currency is fixed once an account exists — its balance and every charge
      on it are already in that currency. Archive it and add another instead.
    </p>`}

    <div class="field"><label>Bank (optional)</label>
      <input class="inp" id="acc_inst" value="${esc(a?.institution ?? '')}"
             placeholder="e.g. BAC Credomatic"></div>

    ${isCard ? '' : `
    <div class="field"><label>Card on this account (optional)</label>
      <div class="tx-2col">
        <select class="inp" id="acc_issuer">
          <option value="">— no card —</option>
          ${[['bac', 'BAC'], ['davivienda', 'Davivienda'], ['promerica', 'Promerica'], ['bncr', 'BNCR']]
            .map(([k, l]) => `<option value="${k}"${a?.issuer === k ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        <input class="inp" id="acc_last4" value="${esc(a?.last4 ?? '')}"
               placeholder="Last 4 digits" inputmode="numeric" maxlength="4">
      </div>
      <div class="muted" style="font-size:11.5px;margin-top:5px;line-height:1.45">
        A debit card is not an account of its own — it spends from this one, so
        its charges come straight off this balance.
      </div></div>`}

    <div class="actions">
      ${isNew ? '<span></span>'
        : `<button class="btn ghost danger" onclick="acctArchive('${esc(a.id)}')">Archive</button>`}
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="acc_save">${isNew ? 'Add' : 'Save'}</button>
    </div>`;
}

export function acctAdd() {
  openModal(accountForm(null));
  wireAccountForm(null);
}

export function acctEdit(id) {
  const a = getAccounts().find((x) => x.id === id);
  if (!a) { toast('Account not found'); return; }
  openModal(accountForm(a));
  wireAccountForm(a);
}

function wireAccountForm(existing) {
  document.getElementById('acc_save')?.addEventListener('click', async () => {
    const label = val('acc_label').trim();
    if (!label) { toast('Give the account a name'); return; }

    const clash = getAccounts().some(
      (x) => x.id !== existing?.id && x.label.toLowerCase() === label.toLowerCase());
    if (clash) { toast('An account with that name already exists'); return; }

    const last4 = val('acc_last4').replace(/\D/g, '');
    const issuer = val('acc_issuer');
    if (issuer && last4.length !== 4) { toast('A card needs its last 4 digits'); return; }
    if (last4 && !issuer) { toast('Choose which bank the card is from'); return; }

    const btn = document.getElementById('acc_save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await getRepo().upsertAccount({
        id: existing?.id,
        label,
        type: existing?.type === 'card' ? 'card' : val('acc_type'),
        currency: existing ? existing.currency : val('acc_currency'),
        institution: val('acc_inst').trim() || null,
        scope: existing?.scope || 'personal',
        issuer: issuer || null,
        brand: issuer ? (existing?.brand || null) : null,
        last4: last4 || null,
      });
      await refreshAccounts();
      closeModal();
      toast(existing ? `${label} saved` : `${label} added`);
    } catch (err) {
      btn.disabled = false; btn.textContent = existing ? 'Save' : 'Add';
      toast(err.message);
    }
  });
}

/**
 * Archiving, not deleting.
 *
 * Transactions and balance snapshots point at accounts. Removing one outright
 * would either orphan that history or take it with it; archiving keeps every
 * charge exactly where it was and only stops the account being offered.
 */
export async function acctArchive(id) {
  const a = getAccounts().find((x) => x.id === id);
  if (!a) { toast('Account not found'); return; }

  let count = 0;
  try {
    count = await getRepo().countTransactions(id);
  } catch {
    count = 0; // not worth blocking on; the warning below is the cautious one
  }

  openModal(`
    <h3>Archive ${esc(a.label)}?</h3>
    <p class="muted" style="font-size:13px;margin:-4px 0 14px;line-height:1.55">
      It stops appearing in lists and totals. Nothing is deleted — the account
      can be brought back, and its history is kept either way.
    </p>
    ${count ? `<div class="card" style="padding:12px 14px;margin-bottom:16px">
      <b>${count} transaction${count === 1 ? '' : 's'}</b>
      ${count === 1 ? 'points' : 'point'} at this account.
      <span class="muted">${count === 1 ? 'It stays' : 'They stay'} in your ledger, but
      ${count === 1 ? 'stops' : 'stop'} counting towards any balance while it is
      archived.</span>
    </div>` : ''}
    <div class="actions">
      <span></span>
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn danger" id="acc_archive">Archive</button>
    </div>`);

  document.getElementById('acc_archive')?.addEventListener('click', async () => {
    const btn = document.getElementById('acc_archive');
    btn.disabled = true; btn.textContent = 'Archiving…';
    try {
      await getRepo().archiveAccount(id);
      await refreshAccounts();
      closeModal();
      toast(`${a.label} archived`);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Archive';
      toast(`Could not archive: ${err.message}`);
    }
  });
}

/** The account list is loaded once at boot, so it has to be re-read. */
async function refreshAccounts() {
  await loadReference();
  invalidateAccounts();
  invalidateWork();
  render();
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
