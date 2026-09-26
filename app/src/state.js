/**
 * State and persistence.
 *
 * Previously localStorage; now backed by whatever repository bootstrap injects.
 * The rest of the app is unchanged: `save()` is still a plain synchronous call
 * made from ~20 mutation sites.
 *
 * Two things make that work over a network:
 *
 *   1. `save()` only marks the state dirty and schedules a flush. It never
 *      awaits, so typing in an input never waits on a round trip.
 *   2. The flush diffs against the last persisted snapshot and writes only the
 *      months that actually changed. Call sites do not say what they touched,
 *      and a JSON comparison over a dozen small month objects costs nothing
 *      next to a request.
 */
import { getRepo } from './repo.js';

export const fmt = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'CRC', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0,
});
export const money = (v) => fmt.format(Math.round(v || 0));
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const DEFAULT_ALLOC = { needs: 50, wants: 30, savings: 20 };

function blankState() {
  return { months: {}, goals: [], settings: { alloc: { ...DEFAULT_ALLOC }, name: '' }, lastSaved: null };
}

export let state = blankState();

/** Replace the whole state object (import, reset). */
export function setState(next) {
  state = next;
  if (!state.settings) state.settings = { alloc: { ...DEFAULT_ALLOC }, name: '' };
  if (!state.months) state.months = {};
  if (!state.goals) state.goals = [];
  markEverythingDirty();
  save();
}

export function uid() { return Math.random().toString(36).slice(2, 9); }

/* current month key like 2026-06 */
export function monthKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
export function monthLabel(key) {
  const [y, m] = key.split('-');
  return MONTHS[+m - 1] + ' ' + y;
}
export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d);
}

export function blankMonth() {
  return {
    income: 0,
    extraIncome: [],        // {id,name,amount}
    bills: [],              // {id,name,amount}  -> essentials (mandatory)
    recurring: [],          // {id,name,amount,cat:'needs'|'wants'}
    oneTime: [],            // {id,name,amount,cat}
    contributions: {},      // goalId -> amount
    invest: 0,              // explicit investing amount
    usedCarryover: 0        // accumulated savings pulled in as income this month
  };
}

export function getMonth(key) {
  if (!state.months[key]) state.months[key] = blankMonth();
  return state.months[key];
}

/* ------------------------------------------------------------ persistence */

const FLUSH_MS = 700;

/** Snapshot of what the server is believed to hold, for diffing. */
let persisted = { months: {}, goals: '', settings: '' };
let timer = null;
let inFlight = false;
let pendingRetry = false;

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function str(v) { return JSON.stringify(v); }

/**
 * Force a rewrite of everything, without forgetting which months the server
 * holds — that set is how flush() knows what to delete. Clearing it outright
 * made "erase all data" wipe only the local copy, and the rows came back at
 * the next sign-in.
 */
function markEverythingDirty() {
  const known = Object.keys(persisted.months);
  persisted = {
    months: Object.fromEntries(known.map((k) => [k, ''])), // '' never matches
    goals: '',
    settings: '',
  };
}

/** Load everything, replacing local state. Called once during bootstrap. */
export async function init() {
  const loaded = await getRepo().loadAll();
  const next = blankState();
  next.months = loaded.months ?? {};
  next.goals = loaded.goals ?? [];
  next.settings = loaded.settings ?? { alloc: { ...DEFAULT_ALLOC }, name: '' };
  if (!next.settings.alloc) next.settings.alloc = { ...DEFAULT_ALLOC };
  state = next;

  // Everything now matches the server, so nothing is dirty.
  persisted = {
    months: Object.fromEntries(Object.entries(state.months).map(([k, v]) => [k, str(v)])),
    goals: str(state.goals),
    settings: str(state.settings),
  };
  status('saved');
}

/**
 * Same signature the app has always called. Schedules a flush rather than
 * writing, and never throws.
 */
export function save() {
  state.lastSaved = Date.now();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { flush(); }, FLUSH_MS);
  status('dirty');
}

/** Write pending changes now. Returns when the round trip finishes. */
export async function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (inFlight) { pendingRetry = true; return; }

  const repo = getRepo();
  const work = [];

  for (const [key, month] of Object.entries(state.months)) {
    const now = str(month);
    if (persisted.months[key] !== now) {
      work.push(['month:' + key, () => repo.saveBudget(key, clone(month)), () => { persisted.months[key] = now; }]);
    }
  }
  // A month removed from state (reset, or an imported file without it) has to
  // be deleted server-side, or it reappears on the next load.
  for (const key of Object.keys(persisted.months)) {
    if (!(key in state.months)) {
      work.push(['del:' + key, () => repo.deleteBudget(key), () => { delete persisted.months[key]; }]);
    }
  }

  const goalsNow = str(state.goals);
  if (persisted.goals !== goalsNow) {
    work.push(['goals', () => repo.saveGoals(clone(state.goals)), () => { persisted.goals = goalsNow; }]);
  }
  const settingsNow = str(state.settings);
  if (persisted.settings !== settingsNow) {
    work.push(['settings', () => repo.saveSettings(clone(state.settings)), () => { persisted.settings = settingsNow; }]);
  }

  if (!work.length) { status('saved'); return; }

  inFlight = true;
  status('saving');
  try {
    for (const [, run, commit] of work) {
      await run();
      // Only mark clean once the write actually landed, so a failure halfway
      // through leaves the rest pending rather than silently dropped.
      commit();
    }
    status('saved');
  } catch (err) {
    console.error('[save]', err);
    status('error', err.message);
    // Retry on the next save(), and once on a timer.
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { flush(); }, 4000);
  } finally {
    inFlight = false;
    if (pendingRetry) { pendingRetry = false; flush(); }
  }
}

/* ----------------------------------------------------------- save status */

let onStatus = null;
/** Bootstrap registers a listener to drive the header indicator. */
export function setStatusListener(fn) { onStatus = fn; }

function status(kind, detail) {
  if (onStatus) onStatus(kind, detail);
  const el = typeof document !== 'undefined' && document.getElementById('lastSaved');
  if (!el) return;
  el.dataset.state = kind; // colours the dot beside it
  if (kind === 'saving') el.textContent = 'Saving…';
  else if (kind === 'error') el.textContent = 'Not saved — retrying';
  else if (kind === 'dirty') el.textContent = 'Unsaved changes';
  else if (state.lastSaved) {
    el.textContent = 'Saved ' + new Date(state.lastSaved)
      .toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  } else el.textContent = 'All changes saved';
}

/** Last chance to persist when the tab goes away. */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
