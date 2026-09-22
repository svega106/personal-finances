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
export function renderSignIn({ reason } = {}) {
  const gate = document.getElementById('gate');
  gate.innerHTML = `
    <div style="min-height:100dvh;display:grid;place-items:center;padding:24px">
      <div class="card" style="max-width:380px;width:100%;text-align:center">
        <h2 style="margin:0 0 6px">Finance Advisor</h2>
        <p class="muted" style="font-size:13px;margin:0 0 20px">
          ${reason ? escapeHtml(reason) : 'Sign in to load your data.'}
        </p>
        <button class="btn" id="signInBtn" style="width:100%">Continue with Google</button>
      </div>
    </div>`;

  const btn = document.getElementById('signInBtn');
  btn?.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Redirecting…';
    try {
      await signInWithGoogle();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Continue with Google';
      const p = btn.parentElement.querySelector('p');
      if (p) p.textContent = err.message || 'Sign-in failed.';
    }
  });
}

/** Shown when the build has no Supabase credentials at all. */
export function renderNotConfigured() {
  const gate = document.getElementById('gate');
  gate.innerHTML = `
    <div style="min-height:100dvh;display:grid;place-items:center;padding:24px">
      <div class="card" style="max-width:460px;width:100%">
        <h2 style="margin:0 0 6px">Not configured</h2>
        <p class="muted" style="font-size:13px;line-height:1.6">
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
