import '@fontsource-variable/inter/opsz.css';
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
  useCarryover, gotoMonth, stepYear, setTheme, openMore, setUser,
} from './app.js';
import { txSetFilter, txClearFilters, txEdit, txSave, txDelete, txRateModal } from './tx-actions.js';
import {
  acctUpdate, acctAdd, acctEdit, acctArchive, acctPickWork, acctSelectAllWork,
  acctSettleOne, acctSettleSelected, acctUnsettle,
} from './accounts-actions.js';
import { loadReference, loadMonth } from './tx.js';
import { updateNavBadge } from './views-tx.js';
import { crMonth } from './cr-date.js';
import { refreshAll } from './refresh.js';
import { toast } from './app.js';
import { icon } from './icons.js';

const VIEWS = ['dashboard', 'plan', 'transactions', 'accounts', 'goals', 'annual', 'settings'];

/** The static shell names its icons; draw them from the one icon set. */
function hydrateIcons() {
  document.querySelectorAll('i[data-icon]').forEach((el) => {
    el.outerHTML = icon(el.dataset.icon, { size: Number(el.dataset.size) || 20 });
  });
}

function showApp(user) {
  document.getElementById('gate').innerHTML = '';
  document.getElementById('app').hidden = false;
  setUser(user ?? {});
  const out = document.getElementById('signOutBtn');
  if (out && user?.email) {
    out.hidden = false;
    out.addEventListener('click', () => signOut());
  }
}

/** What the session says about who is signed in, for the greeting and avatar. */
function userOf(session) {
  const u = session?.user;
  if (!u) return null;
  const meta = u.user_metadata || {};
  return {
    email: u.email ?? '',
    name: meta.full_name || meta.name || '',
    avatar: meta.avatar_url || meta.picture || '',
  };
}

function wire() {
  const onNav = (e) => {
    const b = e.target.closest('button[data-view]'); if (b) setView(b.dataset.view);
  };
  document.getElementById('nav').addEventListener('click', onNav);
  document.getElementById('tabbar').addEventListener('click', onNav);
  document.getElementById('monthSel').addEventListener('change', e => setCurrentMonth(e.target.value));
  document.getElementById('prevMonth').addEventListener('click', () => shiftCurrentMonth(-1));
  document.getElementById('nextMonth').addEventListener('click', () => shiftCurrentMonth(1));
  document.getElementById('refreshBtn')?.addEventListener('click', doRefresh);
  document.getElementById('addBtn')?.addEventListener('click', () => txEdit());
  document.getElementById('fab')?.addEventListener('click', () => txEdit());
  document.getElementById('moreBtn')?.addEventListener('click', () => openMore());

  // Escape closes a sheet, as it would any dialog.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('modalBg').classList.contains('show')) closeModal();
  });

  window.setView = setView;
  window.render = render;
  window.flush = flush;

  Object.assign(window, {
    updIncome, updInvest, updItem, addItem, delItem, updContribution, copyMonth, clearMonth,
    goalModal, saveGoal, delGoal, addToGoal, confirmAddGoal, updAlloc, liveAlloc, setAlloc,
    exportData, importData, resetAll, closeModal, updCarryover, useCarryover, gotoMonth, stepYear,
    setTheme, openMore, doSignOut: () => signOut(),
    txSetFilter, txClearFilters, txEdit, txSave, txDelete, txRateModal,
    acctUpdate, acctAdd, acctEdit, acctArchive, acctPickWork, acctSelectAllWork,
    acctSettleOne, acctSettleSelected, acctUnsettle,
  });
}

/** `/?view=transactions` opens there — the home-screen shortcuts use it. */
function firstView() {
  const v = new URLSearchParams(window.location.search).get('view');
  return VIEWS.includes(v) ? v : 'dashboard';
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
  hydrateIcons();

  // `/?demo` on the dev server: sample data held in memory, so the screens can
  // be worked on without touching the real database. Never in a build.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('demo')) {
    (await import('./demo.js')).installDemoRepo();
  }

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
    setView(firstView());
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

  showApp(userOf(session));
  wire();
  setView(firstView());

  // Populate the review badge without making the user open the view first.
  loadMonth(crMonth(new Date()))
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
