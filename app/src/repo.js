/**
 * The storage contract the app is written against.
 *
 * One implementation talks to Supabase; another keeps everything in memory for
 * tests. Nothing above this module knows which is in use.
 *
 * Every method is async. The app treats saves as fire-and-forget — state.js
 * batches and retries — so a rejected promise must carry a useful message.
 *
 * @typedef {Object} Repo
 * @property {() => Promise<{months: Object, goals: Array, settings: Object}>} loadAll
 * @property {(month: string, data: Object) => Promise<void>} saveBudget
 * @property {(month: string) => Promise<void>} deleteBudget
 * @property {(goals: Array) => Promise<void>} saveGoals
 * @property {(settings: Object) => Promise<void>} saveSettings
 */

/** @type {Repo|null} */
let repo = null;

/** @param {Repo} r */
export function setRepo(r) {
  repo = r;
}

/**
 * Tests inject a repo by setting `window.__REPO__` before any module runs,
 * which also tells main.js to skip the sign-in gate.
 *
 * @returns {Repo}
 */
export function getRepo() {
  if (repo) return repo;
  if (typeof window !== 'undefined' && window.__REPO__) {
    repo = window.__REPO__;
    return repo;
  }
  throw new Error('No repository configured — call setRepo() during bootstrap.');
}

export function hasInjectedRepo() {
  return typeof window !== 'undefined' && !!window.__REPO__;
}
