import './styles.css';
import { init, save, flush, state } from './state.js';
import { setRepo, hasInjectedRepo, getRepo } from './repo.js';
import { configured, createSupabaseRepo, supabase } from './supabase-repo.js';
import { currentSession, renderSignIn, renderNotConfigured, signOut } from './auth.js';
import {
  setView, render, setCurrentMonth, shiftCurrentMonth,
  updIncome, updInvest, updItem, addItem, delItem, updContribution, copyMonth,
  clearMonth, goalModal, saveGoal, delGoal, addToGoal, confirmAddGoal, updAlloc,
  liveAlloc, setAlloc, exportData, importData, resetAll, closeModal, updCarryover,
  useCarryover, gotoMonth, stepYear,
} from './app.js';
import { txSetFilter, txEdit, txSave, txDelete, txRateModal } from './tx-actions.js';
import {
  acctUpdate, acctAdd, acctEdit, acctArchive, acctPickWork, acctSelectAllWork,
  acctSettleOne, acctSettleSelected, acctUnsettle,
} from './accounts-actions.js';
import { loadReference, loadMonth } from './tx.js';
import { updateNavBadge, dayKey } from './views-tx.js';
import { refreshAll } from './refresh.js';
import { toast } from './app.js';

function showApp(email) {
  document.getElementById('gate').innerHTML = '';
  document.getElementById('app').hidden = false;
  const e = document.getElementById('acctEmail');
  if (e && email) e.textContent = email;
  const out = document.getElementById('signOutBtn');
  if (out && email) {
    out.hidden = false;
    out.addEventListener('click', () => signOut());
  }
}

function wire() {
  document.getElementById('nav').addEventListener('click', e => {
    const b = e.target.closest('button'); if (b) setView(b.dataset.view);
  });
  document.getElementById('monthSel').addEventListener('change', e => setCurrentMonth(e.target.value));
  document.getElementById('prevMonth').addEventListener('click', () => shiftCurrentMonth(-1));
  document.getElementById('nextMonth').addEventListener('click', () => shiftCurrentMonth(1));
  document.getElementById('refreshBtn')?.addEventListener('click', doRefresh);

  window.setView = setView;
  window.render = render;
  window.flush = flush;

  Object.assign(window, {
    updIncome, updInvest, updItem, addItem, delItem, updContribution, copyMonth, clearMonth,
    goalModal, saveGoal, delGoal, addToGoal, confirmAddGoal, updAlloc, liveAlloc, setAlloc,
    exportData, importData, resetAll, closeModal, updCarryover, useCarryover, gotoMonth, stepYear,
    txSetFilter, txEdit, txSave, txDelete, txRateModal,
    acctUpdate, acctAdd, acctEdit, acctArchive, acctPickWork, acctSelectAllWork,
    acctSettleOne, acctSettleSelected, acctUnsettle,
  });
}

/**
 * The refresh button.
 *
 * Held busy for a beat past the last response even when everything was
 * already cached: a button that finishes before the eye registers the click
 * reads as a button that did nothing.
 */
let refreshing = false;
async function doRefresh() {
  if (refreshing) return;
  refreshing = true;

  const btn = document.getElementById('refreshBtn');
  btn?.classList.add('busy');
  if (btn) btn.disabled = true;

  const started = Date.now();
  try {
    await refreshAll();
    toast('Up to date');
  } catch (err) {
    console.error('[refresh]', err);
    toast(`Could not refresh: ${err.message}`);
  } finally {
    const held = Math.max(0, 450 - (Date.now() - started));
    setTimeout(() => {
      btn?.classList.remove('busy');
      if (btn) btn.disabled = false;
      refreshing = false;
    }, held);
  }
}

async function boot() {
  // Tests inject a repository and skip the gate entirely.
  if (hasInjectedRepo()) {
    setRepo(getRepo());
    try {
      await init();
      await loadReference();
    } catch (err) {
      // A repo missing part of the contract would otherwise leave a blank page
      // and a harness hanging on a selector that never appears.
      console.error('[boot]', err);
      document.getElementById('gate').innerHTML =
        `<div style="padding:24px"><h2>Repository error</h2>
         <p class="muted">${err.message}</p></div>`;
      return;
    }
    showApp(null);
    wire();
    setView('dashboard');
    return;
  }

  if (!configured) { renderNotConfigured(); return; }

  const session = await currentSession();
  if (!session) { renderSignIn(); return; }

  setRepo(createSupabaseRepo());

  try {
    await init();
    await loadReference();
  } catch (err) {
    console.error('[boot]', err);
    renderSignIn({ reason: `Could not load your data: ${err.message}` });
    return;
  }

  showApp(session.user?.email ?? null);
  wire();
  setView('dashboard');

  // Populate the review badge without making the user open the view first.
  loadMonth(dayKey(new Date()).slice(0, 7))
    .then(updateNavBadge)
    .catch(() => {});

  // A sign-out in another tab should not leave this one showing stale data.
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') window.location.reload();
  });
}

boot();

/* --------------------------------------------------------- installability */

/**
 * Register the service worker, which is what makes the app installable and
 * makes it open instantly on a phone.
 *
 * Registered after boot rather than before: if it ever went wrong, it must
 * not be able to stop the app loading. It is also skipped on the dev server,
 * where a cached shell only gets in the way of the file you just edited.
 */
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // A new build is live. Take it on the next launch rather than swapping
      // the page out from under someone mid-edit.
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            installing.postMessage('skip-waiting');
          }
        });
      });
    }).catch((err) => console.warn('[sw]', err.message));
  });
}
