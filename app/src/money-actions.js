/**
 * The sheets for moving money: Transfer to card, and Add income — and the
 * chooser the phone's + button opens between those and an expense.
 *
 * What is allowed and what gets written is decided in money-moves.js, under
 * test; this module is the form around it. Kept out of the view modules so
 * they have no dependency on app.js, the same split as tx-actions.
 */
import { openModal, closeModal, toast, getActiveView } from './app.js';
import { getRepo } from './repo.js';
import { getAccounts, accountById, saveTransaction, removeTransaction } from './tx.js';
import { findRow, esc, flashRow } from './views-tx.js';
import { money } from './state.js';
import { crDay, crMonth, crShortDate } from './cr-date.js';
import { afterLedgerChange } from './refresh.js';
import { icon } from './icons.js';
import {
  transferSources, transferDestinations, incomeAccounts,
  validateTransfer, validateIncome, transferRow, incomeRow, crossCurrency,
} from './money-moves.js';

const val = (id) => document.getElementById(id)?.value ?? '';
const today = () => crDay(new Date());

function fmt(amount, currency) {
  if (currency === 'CRC') return money(amount);
  return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const symbol = (currency) => (currency === 'CRC' ? '₡' : '$');

/**
 * Balances as they are right now. Read fresh for every sheet: the overdraw
 * check is only as good as the figure it checks against.
 */
async function freshBalances() {
  const list = await getRepo().listAccountBalances();
  return new Map(list.map((b) => [b.accountId, b]));
}

/**
 * A balance recorded on or after the day picked already includes it — the
 * same day too, which is the easy one to trip on: set a card's balance this
 * morning, pay it this afternoon, and the payment is already in that figure.
 */
function coveredNote(account, balance, date) {
  if (!account || !balance?.hasSnapshot || !date || date > balance.snapshotDate) return '';
  return `The balance you recorded for ${esc(account.label)} on ${esc(crShortDate(balance.snapshotDate))} `
    + 'already includes everything up to that day, so this is kept in its history without changing that balance.';
}

/* ------------------------------------------------------ Transfer to card */

export async function openTransfer(id) {
  const existing = id ? findRow(id) : null;
  if (id && !existing) { toast('Transfer not found'); return; }

  let balances;
  try {
    balances = await freshBalances();
  } catch (err) {
    toast(`Could not read balances: ${err.message}`);
    return;
  }

  const accounts = getAccounts();
  const sources = transferSources(accounts);
  const dests = transferDestinations(accounts);
  if (!sources.length || !dests.length) {
    openModal(`
      <h3>Transfer to card</h3>
      <p class="sheet-sub">A transfer needs a savings account to pay from and a credit card to pay.
        ${!sources.length ? 'There is no savings account yet — add one on the Accounts tab.' : 'There is no credit card yet.'}</p>
      <div class="actions"><span></span><button class="btn" onclick="closeModal()">OK</button></div>`);
    return;
  }

  const pickSource = existing?.accountId ?? sources[0].id;
  const pickDest = existing?.counterpartyAccountId ?? dests[0].id;
  const option = (a, selected, extra) =>
    `<option value="${esc(a.id)}"${a.id === selected ? ' selected' : ''}>${esc(a.label)}${extra ? ` — ${extra}` : ''}</option>`;

  openModal(`
    <h3>${existing ? 'Edit transfer' : 'Transfer to card'}</h3>
    <p class="sheet-sub">Pays a credit card from savings: it comes off the savings balance and off what
      the card owes. A transfer is not spending, so it never counts against the budget.</p>

    <div class="field"><label for="mv_source">From</label>
      <select class="inp" id="mv_source">
        ${sources.map((a) => {
          const b = balances.get(a.id);
          return option(a, pickSource, b?.hasSnapshot ? fmt(b.currentBalance, a.currency) : 'balance not recorded');
        }).join('')}
      </select></div>

    <div class="field"><label for="mv_dest">To card</label>
      <select class="inp" id="mv_dest">
        ${dests.map((a) => {
          const b = balances.get(a.id);
          const owed = b ? Math.max(0, -b.currentBalance) : 0;
          return option(a, pickDest, owed ? `owes ${fmt(owed, a.currency)}` : 'nothing owed');
        }).join('')}
      </select></div>

    <label class="amount-lbl" for="mv_amount" id="mv_lbl" hidden></label>
    <div class="amount-field">
      <span class="amount-sym" id="mv_cur" aria-hidden="true">₡</span>
      <input class="amount-inp" id="mv_amount" type="number" inputmode="decimal" step="0.01" min="0"
             value="${existing?.amount ?? ''}" placeholder="0" aria-label="Amount">
    </div>
    <div id="mv_second" hidden>
      <label class="amount-lbl" for="mv_amount2" id="mv_lbl2"></label>
      <div class="amount-field">
        <span class="amount-sym" id="mv_cur2" aria-hidden="true">$</span>
        <input class="amount-inp" id="mv_amount2" type="number" inputmode="decimal" step="0.01" min="0"
               value="${existing?.counterpartyAmount ?? ''}" placeholder="0">
      </div>
    </div>
    <p class="move-hint" id="mv_hint" aria-live="polite"></p>

    <div class="tx-2col">
      <div class="field"><label for="mv_date">Date</label>
        <input class="inp" id="mv_date" type="date" value="${existing ? crDay(existing.postedAt) : today()}"></div>
      <div class="field"><label for="mv_note">Note <span class="faint">(optional)</span></label>
        <input class="inp" id="mv_note" value="${esc(existing?.note ?? '')}" placeholder="e.g. September statement"></div>
    </div>

    <div class="actions">
      ${existing ? `<button class="btn ghost danger" onclick="moveDelete('${esc(existing.id)}')" aria-label="Delete">${icon('trash')}<span class="lbl">Delete</span></button>` : '<span></span>'}
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="mv_save">${existing ? 'Save' : 'Transfer'}</button>
    </div>`);

  const read = () => {
    const source = accountById(val('mv_source'));
    const dest = accountById(val('mv_dest'));
    return {
      source, dest,
      amount: Number(val('mv_amount')),
      destAmount: Number(val('mv_amount2')),
      date: val('mv_date'),
      balance: balances.get(source?.id),
      original: existing,
    };
  };

  // What it leaves behind, as you type — before Save, not after.
  // Once Save has been pressed, every missing figure is an error worth
  // showing; before that, only what has been typed is judged.
  let tried = false;
  const hint = () => {
    const f = read();
    const cross = crossCurrency(f.source, f.dest);
    document.getElementById('mv_cur').textContent = symbol(f.source?.currency);
    // Across currencies there are two figures, so each says which it is.
    // Within one there is only the one, and it needs no label.
    const lbl = document.getElementById('mv_lbl');
    lbl.hidden = !cross;
    document.getElementById('mv_second').hidden = !cross;
    if (cross) {
      lbl.textContent = `Taken from ${f.source.label}`;
      document.getElementById('mv_lbl2').textContent = `Paid off ${f.dest.label}`;
      document.getElementById('mv_cur2').textContent = symbol(f.dest.currency);
    }
    const el = document.getElementById('mv_hint');
    const lines = [];
    const typed = val('mv_amount') !== '';
    const typed2 = tried || !cross || val('mv_amount2') !== '';
    // Complain only about what has been filled in: an untouched second figure
    // is not yet an error, but an overdraw on the first already is.
    const err = typed ? validateTransfer(typed2 ? f : { ...f, destAmount: 1 })
      : (!f.balance?.hasSnapshot ? validateTransfer({ ...f, amount: 1, destAmount: 1 }) : null);
    if (err) {
      el.className = 'move-hint bad';
      el.innerHTML = `${icon('alert', { size: 15 })}<span>${esc(err)}</span>`;
      return;
    }
    if (f.balance?.hasSnapshot) {
      const giveBack = existing && existing.accountId === f.source.id ? existing.amount : 0;
      const available = f.balance.currentBalance + giveBack;
      const after = typed ? available - f.amount : available;
      lines.push(`${fmt(available, f.source.currency)} in ${esc(f.source.label)}${typed ? ` · ${fmt(after, f.source.currency)} after` : ''}`);
    }
    // The rate the bank used, worked back from the two figures — a quick
    // check that neither was mistyped.
    if (cross && typed && typed2 && f.amount > 0 && f.destAmount > 0) {
      const [crc, usd] = f.source.currency === 'CRC' ? [f.amount, f.destAmount] : [f.destAmount, f.amount];
      lines.push(`That is ${money(crc / usd)} per dollar.`);
    }
    for (const [acct, bal] of [[f.source, f.balance], [f.dest, balances.get(f.dest?.id)]]) {
      const covered = coveredNote(acct, bal, f.date);
      if (covered) lines.push(covered);
    }
    el.className = 'move-hint';
    el.innerHTML = lines.map((l) => `<span>${l}</span>`).join('');
  };

  for (const id2 of ['mv_source', 'mv_dest', 'mv_amount', 'mv_amount2', 'mv_date']) {
    document.getElementById(id2)?.addEventListener('input', hint);
    document.getElementById(id2)?.addEventListener('change', hint);
  }
  hint();

  document.getElementById('mv_save')?.addEventListener('click', async () => {
    const f = read();
    const err = validateTransfer(f);
    if (err) { tried = true; toast(err); hint(); return; }
    const row = transferRow({ ...f, note: val('mv_note'), existing });
    const paid = crossCurrency(f.source, f.dest)
      ? `${fmt(f.amount, f.source.currency)} (${fmt(f.destAmount, f.dest.currency)})` : fmt(f.amount, f.source.currency);
    await save(row, 'mv_save', existing ? 'Transfer updated' : `Transferred ${paid} to ${f.dest.label}`);
  });
}

/* ------------------------------------------------------------ Add income */

export async function openIncome(id) {
  const existing = id ? findRow(id) : null;
  if (id && !existing) { toast('Income not found'); return; }

  let balances;
  try {
    balances = await freshBalances();
  } catch (err) {
    toast(`Could not read balances: ${err.message}`);
    return;
  }

  const targets = incomeAccounts(getAccounts());
  if (!targets.length) {
    openModal(`
      <h3>Add income</h3>
      <p class="sheet-sub">Income goes into a savings account, and there is none yet — add one on the Accounts tab.</p>
      <div class="actions"><span></span><button class="btn" onclick="closeModal()">OK</button></div>`);
    return;
  }
  const pick = existing?.accountId ?? targets[0].id;

  openModal(`
    <h3>${existing ? 'Edit income' : 'Add income'}</h3>
    <p class="sheet-sub">Money coming in — a paycheck, a refund, a sale. It adds to the savings balance, and is
      kept apart from transfers and from spending.</p>

    <div class="field"><label for="in_account">Into</label>
      <select class="inp" id="in_account">
        ${targets.map((a) => {
          const b = balances.get(a.id);
          return `<option value="${esc(a.id)}"${a.id === pick ? ' selected' : ''}>${esc(a.label)}${b?.hasSnapshot ? ` — ${fmt(b.currentBalance, a.currency)}` : ''}</option>`;
        }).join('')}
      </select></div>

    <div class="amount-field">
      <span class="amount-sym" id="in_cur" aria-hidden="true">₡</span>
      <input class="amount-inp" id="in_amount" type="number" inputmode="decimal" step="0.01" min="0"
             value="${existing?.amount ?? ''}" placeholder="0" aria-label="Amount">
    </div>
    <p class="move-hint" id="in_hint" aria-live="polite"></p>

    <div class="field"><label for="in_from">From</label>
      <input class="inp" id="in_from" value="${esc(existing?.merchant ?? '')}" placeholder="e.g. Paycheck" autocomplete="off"></div>
    <div class="tx-2col">
      <div class="field"><label for="in_date">Date</label>
        <input class="inp" id="in_date" type="date" value="${existing ? crDay(existing.postedAt) : today()}"></div>
      <div class="field"><label for="in_note">Note <span class="faint">(optional)</span></label>
        <input class="inp" id="in_note" value="${esc(existing?.note ?? '')}"></div>
    </div>

    <div class="actions">
      ${existing ? `<button class="btn ghost danger" onclick="moveDelete('${esc(existing.id)}')" aria-label="Delete">${icon('trash')}<span class="lbl">Delete</span></button>` : '<span></span>'}
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" id="in_save">${existing ? 'Save' : 'Add income'}</button>
    </div>`);

  const read = () => ({
    account: accountById(val('in_account')),
    amount: Number(val('in_amount')),
    date: val('in_date'),
  });

  const hint = () => {
    const f = read();
    document.getElementById('in_cur').textContent = symbol(f.account?.currency);
    const el = document.getElementById('in_hint');
    const b = balances.get(f.account?.id);
    const lines = [];
    if (b?.hasSnapshot && f.amount > 0) {
      const giveBack = existing && existing.accountId === f.account.id ? existing.amount : 0;
      lines.push(`${esc(f.account.label)}: ${fmt(b.currentBalance - giveBack, f.account.currency)} → ${fmt(b.currentBalance - giveBack + f.amount, f.account.currency)}`);
    }
    const covered = coveredNote(f.account, b, f.date);
    if (covered) lines.push(covered);
    el.className = 'move-hint';
    el.innerHTML = lines.map((l) => `<span>${l}</span>`).join('');
  };
  for (const id2 of ['in_account', 'in_amount', 'in_date']) {
    document.getElementById(id2)?.addEventListener('input', hint);
    document.getElementById(id2)?.addEventListener('change', hint);
  }
  hint();

  document.getElementById('in_save')?.addEventListener('click', async () => {
    const f = read();
    const err = validateIncome(f);
    if (err) { toast(err); return; }
    const row = incomeRow({ ...f, from: val('in_from'), note: val('in_note'), existing });
    await save(row, 'in_save', existing ? 'Income updated' : `${fmt(f.amount, f.account.currency)} added to ${f.account.label}`);
  });
}

/* ------------------------------------------------------------- shared */

async function save(row, buttonId, message) {
  const btn = document.getElementById(buttonId);
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const saved = await saveTransaction(row);
    closeModal();
    if (getActiveView() === 'transactions') flashRow(saved?.id ?? row.id);
    // Both balances are derived from the ledger: Accounts must re-read.
    await afterLedgerChange(crMonth(row.postedAt));
    toast(message);
  } catch (err) {
    console.error('[move]', err);
    if (btn) { btn.disabled = false; btn.textContent = label; }
    toast(`Could not save: ${err.message}`);
  }
}

export async function moveDelete(id) {
  const t = findRow(id);
  if (!t) { toast('Not found'); return; }
  const what = t.kind === 'transfer' ? 'this transfer' : 'this income';
  if (!confirm(`Delete ${what}? ${t.kind === 'transfer' ? 'Both balances go back to how they were.' : 'The savings balance goes back down.'}`)) return;
  try {
    await removeTransaction(t);
    closeModal();
    await afterLedgerChange(crMonth(t.postedAt));
    toast(t.kind === 'transfer' ? 'Transfer deleted' : 'Income deleted');
  } catch (err) {
    toast(`Could not delete: ${err.message}`);
  }
}

/* ------------------------------------------------------------ the + */

/** The phone's + button: an expense, money in, or a card payment. */
export function openAddChooser() {
  const row = (fn, ic, tone, title, sub) => `
    <button type="button" class="choose-row" onclick="${fn}">
      <span class="gi tone-${tone}">${icon(ic)}</span>
      <span class="choose-text"><b>${title}</b><span>${sub}</span></span>
      ${icon('chevron-right', { size: 18 })}
    </button>`;
  openModal(`
    <h3>Add</h3>
    <div class="choose-list">
      ${row("closeModal();txEdit()", 'receipt', 'needs', 'Expense', 'Something bought, in cash or on a card')}
      ${row("closeModal();openIncome()", 'income', 'income', 'Income', 'A paycheck or anything else coming in')}
      ${row("closeModal();openTransfer()", 'transfer', 'transfer', 'Transfer to card', 'Pay a credit card from savings')}
    </div>`);
}
