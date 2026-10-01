/**
 * Interactions for the accounts view: recording a balance, adding an account,
 * settling work charges.
 *
 * Kept out of views-accounts.js so the rendering module has no dependency on
 * app.js, which would create an import cycle.
 */
import { openModal, closeModal, toast, render } from './app.js';
import { getRepo } from './repo.js';
import { getAccounts, loadMonth, saveTransaction } from './tx.js';
import { esc } from './views-tx.js';
import { icon, accountIcon } from './icons.js';
import { crDay } from './cr-date.js';
import { afterLedgerChange, afterAccountChange } from './refresh.js';
import { accountPatch } from './account-patch.js';
import {
  cachedBalances, invalidateAccounts, onWorkLoaded,
  workSelected, clearWorkSelection, setAllWorkSelected, pickWork,
} from './views-accounts.js';
import { cachedWork, settle, unsettle } from './work.js';
import { openIncome } from './money-actions.js';

// The Costa Rica day. An ISO slice would date a balance recorded after 6pm
// as tomorrow's snapshot.
const today = () => crDay(new Date());
const val = (id) => document.getElementById(id)?.value ?? '';

const round2 = (n) => Math.round(n * 100) / 100;

function findBalance(accountId) {
  return (cachedBalances() ?? []).find((b) => b.accountId === accountId) || null;
}

/* ------------------------------------------------------ record a balance */

/**
 * A card's balance is stored as it is everywhere else — negative, money owed —
 * but asked for the way a statement shows it: what is owed, as a positive
 * figure. A credit in your favour is entered as a negative one.
 *
 * Whatever the transactions currently add up to is offered as the starting
 * figure for a card, recorded or not: charges arrive by themselves, so it is
 * usually close. A savings account shows nothing until one has been recorded,
 * because without one its total is only what the app happened to see.
 */
export function acctUpdate(accountId) {
  const b = findBalance(accountId);
  if (!b) { toast('Account not found'); return; }

  const acct = getAccounts().find((x) => x.id === accountId) || { type: b.type, label: b.label };
  const isCard = b.type === 'card';
  const shown = isCard ? round2(-b.currentBalance) : b.hasSnapshot ? b.currentBalance : '';
  openModal(`
    <h3>${isCard ? `What ${esc(b.label)} owes` : `Balance for ${esc(b.label)}`}</h3>
    <p class="sheet-sub">${isCard
      ? `Enter what the bank shows as owed on the ${b.currency === 'CRC' ? 'colón' : 'dollar'} balance right now.
         Charges after this moment are added on top and payments come off, so you only
         need to do this when the two have drifted apart.`
      : `Enter what the account actually holds right now. Anything recorded
         after this moment is added on top, so you only need to do this when the
         two have drifted apart.`}
    </p>

    <div class="amount-field">
      ${accountIcon({ ...acct, type: b.type })}
      <span class="muted" style="font-weight:700">${b.currency === 'CRC' ? '₡' : '$'}</span>
      <input class="amount-inp" id="bal_amount" type="number" inputmode="decimal" step="0.01"
             value="${shown}" placeholder="0"
             aria-label="${isCard ? 'Owed' : 'Balance'} (${esc(b.currency)})">
    </div>
    ${isCard ? '<p class="field-hint" style="margin:-8px 0 14px">If the bank owes you — you paid more than was due — enter it as a negative amount.</p>' : ''}

    <div class="tx-2col">
      <div class="field"><label for="bal_date">As of</label>
        <input class="inp" id="bal_date" type="date" value="${today()}"></div>
      <div class="field"><label for="bal_note">Note <span class="faint">(optional)</span></label>
        <input class="inp" id="bal_note" placeholder="e.g. after the bonus"></div>
    </div>
    <p class="field-hint" style="margin:-8px 0 14px">
      Today means right now: anything entered after this counts on top. An earlier
      date means the end of that day.
    </p>

    <div class="actions">
      ${isCard ? `<button class="btn ghost" onclick="acctEdit('${esc(accountId)}')">${icon('settings')}<span class="lbl">Card settings</span></button>` : '<span></span>'}
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="bal_save">Save</button>
    </div>`);

  document.getElementById('bal_save')?.addEventListener('click', async () => {
    const typed = val('bal_amount');
    const entered = Number(typed);
    if (typed.trim() === '' || !Number.isFinite(entered)) { toast(isCard ? 'Enter what is owed' : 'Enter a balance'); return; }
    // Owed on a card is a negative balance.
    const balance = isCard ? -entered : entered;
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
      toast(`${b.label} set to ${b.currency === 'CRC' ? '₡' : '$'}${entered.toLocaleString()}${isCard ? ' owed' : ''}`);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Save';
      toast(`Could not save: ${err.message}`);
    }
  });
}

/* ------------------------------------------------- adding and editing accounts */

const BANKS = [
  ['bac', 'BAC'], ['davivienda', 'Davivienda'], ['promerica', 'Promerica'], ['bncr', 'BNCR'],
  // Charges from a bank whose emails are not read are added by hand.
  ['other', 'Another bank'],
];
const NETWORKS = [['visa', 'Visa'], ['mastercard', 'Mastercard'], ['amex', 'American Express']];

/** "BAC VISA ₡" and "BAC VISA $" are one card called "BAC VISA". */
function baseName(label) {
  return String(label || '').replace(/[₡$]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * One form for adding and editing. They differ only in whether there is
 * something to archive and whether the kind and currency are still free to
 * choose, so keeping them apart would mean two forms drifting out of step.
 *
 * A new account can be a credit card. A card is two accounts — its colón and
 * its dollar balance — so adding one adds both unless only one is wanted.
 * Fields that belong to one kind carry `data-for`, and are shown or hidden as
 * the kind changes.
 */
function accountForm(a) {
  const isNew = !a?.id;
  const type = a?.type || 'savings';
  const isCard = type === 'card';
  const twin = sibling(a);
  const opt = (v, l, on) => `<option value="${v}"${on ? ' selected' : ''}>${l}</option>`;

  return `
    <h3>${isNew ? 'Add an account' : esc(a.label)}</h3>
    <p class="sheet-sub">
      ${isNew ? '' : `${accountIcon(a, { size: 'sm' })}`}
      <span>${isNew
        ? 'Savings, investments or cash you keep track of yourself — or a credit card.'
        : 'Renaming is safe at any time — transactions follow the account, not its name.'}</span>
    </p>

    <div class="field"><label for="acc_label">Name</label>
      <input class="inp" id="acc_label" value="${esc(a?.label ?? '')}"
             placeholder="e.g. Ahorros BAC" autocomplete="off"></div>

    <div class="tx-2col">
      <div class="field"><label for="acc_type">Kind</label>
        <select class="inp" id="acc_type"${isCard ? ' disabled' : ''}>
          ${isNew || isCard ? opt('card', 'Credit card', isCard) : ''}
          ${isCard ? '' : `
          ${opt('savings', 'Savings', type === 'savings')}
          ${opt('investment', 'Investment', type === 'investment')}
          ${opt('cash', 'Cash', type === 'cash')}`}
        </select></div>
      <div class="field"${isNew ? ' data-for="other"' : ''}><label for="acc_currency">Currency</label>
        <select class="inp" id="acc_currency"${isNew ? '' : ' disabled'}>
          ${opt('CRC', 'CRC', (a?.currency ?? 'CRC') === 'CRC')}
          ${opt('USD', 'USD', a?.currency === 'USD')}
        </select></div>
      ${isNew ? `<div class="field" data-for="card"><label for="acc_bals">Balances</label>
        <select class="inp" id="acc_bals">
          ${opt('both', '₡ and $', true)}
          ${opt('CRC', '₡ only', false)}
          ${opt('USD', '$ only', false)}
        </select></div>` : ''}
    </div>
    ${isNew ? `<p class="field-hint" data-for="card" style="margin:-8px 0 14px">
      A Costa Rican credit card usually has a colón and a dollar balance, billed
      separately. Each becomes a balance of its own here, named “… ₡” and “… $”.
    </p>` : `<p class="field-hint" style="margin:-8px 0 14px">
      Currency is fixed once an account exists — its balance and every charge
      on it are already in that currency. Archive it and add another instead.
    </p>`}

    <div class="field"><label for="acc_inst">Bank <span class="faint">(optional)</span></label>
      <input class="inp" id="acc_inst" value="${esc(a?.institution ?? '')}"
             placeholder="e.g. BAC Credomatic"></div>

    <div class="field">
      <label for="acc_issuer">
        <span data-for="card">Card</span>
        <span data-for="other">Card on this account <span class="faint">(optional)</span></span>
      </label>
      <div class="tx-2col">
        <select class="inp" id="acc_issuer">
          <option value=""${a?.issuer ? '' : ' selected'}>— choose the bank —</option>
          ${BANKS.map(([k, l]) => opt(k, l, a?.issuer === k)).join('')}
        </select>
        <input class="inp" id="acc_last4" value="${esc(a?.last4 ?? '')}"
               placeholder="Last 4 digits" inputmode="numeric" maxlength="4">
      </div>
      <div class="field-hint">
        <span data-for="card">This is how a charge finds its way here. The bank names the card by
          these four digits and nothing else, so an account without them can
          never be matched to anything. On another bank, charges are added by hand.</span>
        <span data-for="other">A debit card is not an account of its own — it spends from this one,
          so its charges come straight off this balance. It has no bill, so
          no cutoff.</span>
      </div></div>

    <div data-for="card">
      <div class="tx-2col">
        <div class="field"><label for="acc_brand">Network</label>
          <select class="inp" id="acc_brand">
            ${opt('', '—', !a?.brand)}
            ${NETWORKS.map(([k, l]) => opt(k, l, a?.brand === k)).join('')}
          </select></div>
        ${isNew ? `<div class="field"><label for="acc_scope">Who pays it</label>
          <select class="inp" id="acc_scope">
            ${opt('personal', 'I do', true)}
            ${opt('work', 'My company', false)}
          </select></div>` : '<div></div>'}
      </div>
      ${isNew ? `<p class="field-hint" style="margin:-6px 0 14px">
        A card the company pays is kept out of your spending and your net position,
        like the BNCR card.
      </p>` : ''}

      <div class="tx-2col">
        <div class="field"><label for="acc_cutoff">Billing cutoff <span class="faint">(day of month)</span></label>
          <input class="inp" id="acc_cutoff" type="number" inputmode="numeric" min="1" max="31"
                 value="${a?.cutoffDay ?? ''}" placeholder="e.g. 15"></div>
        <div class="field"><label for="acc_warn">Remind me <span class="faint">(days before)</span></label>
          <input class="inp" id="acc_warn" type="number" inputmode="numeric" min="0" max="31"
                 value="${a?.cutoffWarnDays ?? 3}"></div>
      </div>
      <p class="field-hint" style="margin:-6px 0 14px">
        The same every month; a day the month does not have means its last day.
        Applies to the whole card — ${twin ? `${esc(twin.label)} is updated with it` : 'both its balances'}.
      </p>
    </div>

    <div class="actions">
      ${isNew ? '<span></span>'
        : `<button class="btn ghost danger" onclick="acctArchive('${esc(a.id)}')">${icon('archive')}<span class="lbl">${isCard ? 'Remove card' : 'Archive'}</span></button>`}
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="acc_save">${isNew ? 'Add' : 'Save'}</button>
    </div>`;
}

/** The other currency half of a credit card: same bank, same four digits. */
function sibling(a) {
  if (!a || a.type !== 'card' || !a.issuer || !a.last4) return null;
  return getAccounts().find((x) => x.id !== a.id && x.type === 'card'
    && x.issuer === a.issuer && x.last4 === a.last4) || null;
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

/** Show the fields for the kind picked, hide the rest. */
function showKind() {
  const card = val('acc_type') === 'card';
  for (const el of document.querySelectorAll('[data-for]')) {
    el.hidden = (el.dataset.for === 'card') !== card;
  }
  const label = document.getElementById('acc_label');
  if (label) label.placeholder = card ? 'e.g. BAC VISA' : 'e.g. Ahorros BAC';
}

function wireAccountForm(existing) {
  showKind();
  document.getElementById('acc_type')?.addEventListener('change', showKind);

  document.getElementById('acc_save')?.addEventListener('click', async () => {
    const isCard = val('acc_type') === 'card';
    // Only fields the form offered for this kind. Absent is not empty.
    const fields = {
      label: val('acc_label'), institution: val('acc_inst'),
      type: val('acc_type'), issuer: val('acc_issuer'), last4: val('acc_last4'),
    };
    if (!existing) fields.currency = val('acc_currency');
    if (isCard) {
      fields.brand = val('acc_brand');
      fields.cutoffDay = val('acc_cutoff');
      fields.cutoffWarnDays = val('acc_warn');
      if (!existing) fields.scope = val('acc_scope');
    }

    // A new card is one account per balance it carries.
    let rows;
    if (!existing && isCard) {
      const name = baseName(fields.label);
      const bals = val('acc_bals');
      rows = [];
      for (const cur of bals === 'both' ? ['CRC', 'USD'] : [bals]) {
        const { row, error } = accountPatch(null, {
          ...fields, currency: cur, label: name ? `${name} ${cur === 'CRC' ? '₡' : '$'}` : '',
        });
        if (error) { toast(error); return; }
        rows.push(row);
      }
    } else {
      const { row, error } = accountPatch(existing, fields);
      if (error) { toast(error); return; }
      rows = [row];
    }

    for (const row of rows) {
      const clash = getAccounts().some(
        (x) => x.id !== existing?.id && x.label.toLowerCase() === row.label.toLowerCase());
      if (clash) { toast(`An account called ${row.label} already exists`); return; }
    }

    const btn = document.getElementById('acc_save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      for (const r of rows) await getRepo().upsertAccount(r);
      const [row] = rows;
      // The cutoff and the network are the card's, not one currency's: the
      // other half gets the same, so the reminder and the dashboard never
      // disagree with it.
      const twin = existing && sibling(existing);
      const twinDiffers = twin && ((twin.cutoffDay ?? null) !== row.cutoffDay
        || (twin.cutoffWarnDays ?? 3) !== row.cutoffWarnDays
        || (twin.brand ?? null) !== (row.brand ?? null));
      if (twinDiffers) {
        const { row: twinRow, error: twinErr } = accountPatch(twin, {
          label: twin.label, institution: twin.institution ?? '',
          cutoffDay: row.cutoffDay ?? '', cutoffWarnDays: row.cutoffWarnDays, brand: row.brand ?? '',
        });
        if (twinErr) throw new Error(twinErr);
        await getRepo().upsertAccount(twinRow);
      }
      await refreshAccounts();
      closeModal();
      toast(existing ? `${row.label} saved`
        : isCard ? `${baseName(row.label)} added${rows.length > 1 ? ', colones and dollars' : ''}`
          : `${row.label} added`);
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
 *
 * A card goes as a whole: its colón and dollar balances are one card, and
 * leaving one behind would keep half a closed card in every list.
 */
export async function acctArchive(id) {
  const a = getAccounts().find((x) => x.id === id);
  if (!a) { toast('Account not found'); return; }
  const twin = sibling(a);
  const ids = twin ? [a.id, twin.id] : [a.id];
  const name = twin ? baseName(a.label) : a.label;
  const isCard = a.type === 'card';

  let count = 0;
  try {
    count = (await Promise.all(ids.map((x) => getRepo().countTransactions(x)))).reduce((s, n) => s + n, 0);
  } catch {
    count = 0; // not worth blocking on; the warning below is the cautious one
  }

  openModal(`
    <h3>${isCard ? 'Remove' : 'Archive'} ${esc(name)}?</h3>
    <p class="sheet-sub">
      ${twin ? 'Both its balances, colones and dollars, stop' : 'It stops'} appearing in lists
      and totals${isCard ? ', and its cutoff reminders end' : ''}. Nothing is deleted:
      every transaction stays in Activity.
    </p>
    ${count ? `<div class="note-card">
      <b>${count} transaction${count === 1 ? '' : 's'}</b>
      ${count === 1 ? 'points' : 'point'} at ${isCard ? 'this card' : 'this account'}.
      <span class="muted">${count === 1 ? 'It stays' : 'They stay'} in your ledger, but
      ${count === 1 ? 'stops' : 'stop'} counting towards any balance.</span>
    </div>` : ''}
    <div class="actions">
      <span></span>
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn danger" id="acc_archive">${isCard ? 'Remove' : 'Archive'}</button>
    </div>`);

  document.getElementById('acc_archive')?.addEventListener('click', async () => {
    const btn = document.getElementById('acc_archive');
    btn.disabled = true; btn.textContent = isCard ? 'Removing…' : 'Archiving…';
    try {
      for (const x of ids) await getRepo().archiveAccount(x);
      await refreshAccounts();
      closeModal();
      toast(`${name} ${isCard ? 'removed' : 'archived'}`);
    } catch (err) {
      btn.disabled = false; btn.textContent = isCard ? 'Remove' : 'Archive';
      toast(`Could not ${isCard ? 'remove' : 'archive'}: ${err.message}`);
    }
  });
}

const refreshAccounts = afterAccountChange;

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
 * The money came back: record it as income into an account, with the
 * selected charges ticked as what it pays back. Saving it settles them.
 */
export function acctRepaySelected() {
  const ids = [...workSelected()].filter((id) => findWork(id));
  if (!ids.length) { toast('Nothing selected'); return; }
  // The sheet has its own ticks now; these would only go stale.
  clearWorkSelection();
  openIncome(null, { covers: ids });
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
    <p class="sheet-sub">
      The charges stay in your history — only their status changes. You can
      undo any of them afterwards.
    </p>
    <div class="field"><label for="rb_date">Reimbursed on</label>
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

// Settling writes to the charge itself, so it is a ledger change like any
// other: the balances and the month on screen both have to be re-read.
const refreshWork = () => afterLedgerChange();
