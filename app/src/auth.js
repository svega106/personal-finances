/**
 * Sign-in gate.
 *
 * The app is a single user's complete financial history on a public URL, so it
 * does not render at all until there is a session. Row-level security is the
 * real protection; this is the door.
 */
import { supabase, configured } from './supabase-repo.js';

/** @returns {Promise<import('@supabase/supabase-js').Session|null>} */
export async function currentSession() {
  if (!configured) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('[auth] getSession', error);
    return null;
  }
  return data.session ?? null;
}

export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.reload();
}

/**
 * Paint the sign-in screen and resolve once signed in.
 *
 * Renders into the existing shell rather than a separate page, so there is one
 * place that styles exist and no flash of an empty app.
 */
/** The app's mark: a line going up, and where it is headed. */
const LOGO = `<div class="logo"><svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
  <path d="M5.5 22.5 12 15l5 4 9.5-11" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="26.5" cy="8" r="3.2" fill="#fff"/></svg></div>`;

/** Google's own mark, which its sign-in guidelines ask a sign-in button to carry. */
const GOOGLE = `<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
  <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
  <path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
  <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
  <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>`;

const CHECK = '<svg class="i" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

export function renderSignIn({ reason } = {}) {
  const gate = document.getElementById('gate');
  gate.innerHTML = `
    <div class="gate">
      <div class="card gate-card">
        ${LOGO}
        <h2>Finances</h2>
        <p id="gateMsg">${reason ? escapeHtml(reason) : 'Your budget, your cards and your savings — in one place. Sign in to load your data.'}</p>
        <button class="btn block google-btn" id="signInBtn">${GOOGLE}<span>Continue with Google</span></button>
        <div class="gate-points">
          <span>${CHECK}Plan vs. actual</span><span>${CHECK}Card charges from email</span><span>${CHECK}Colones & dollars</span>
        </div>
      </div>
    </div>`;

  const btn = document.getElementById('signInBtn');
  const label = btn?.querySelector('span');
  btn?.addEventListener('click', async () => {
    btn.disabled = true;
    label.textContent = 'Redirecting…';
    try {
      await signInWithGoogle();
    } catch (err) {
      btn.disabled = false;
      label.textContent = 'Continue with Google';
      const p = document.getElementById('gateMsg');
      if (p) p.textContent = err.message || 'Sign-in failed.';
    }
  });
}

/** Shown when the build has no Supabase credentials at all. */
export function renderNotConfigured() {
  const gate = document.getElementById('gate');
  gate.innerHTML = `
    <div class="gate">
      <div class="card gate-card" style="max-width:460px;text-align:left">
        ${LOGO}
        <h2 style="text-align:center">Not configured</h2>
        <p style="margin-bottom:0">
          This build has no Supabase credentials. Copy <code>.env.example</code>
          to <code>.env.local</code> and fill in
          <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>,
          then restart the dev server.
        </p>
      </div>
    </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}
