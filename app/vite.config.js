import { defineConfig } from 'vite';

/**
 * The only reason this file exists.
 *
 * `matchRule` and the bank parsers are shared with the Supabase ingest
 * function, so they live in `supabase/functions/_shared/` — one copy, so a
 * charge is categorized the same way whether it was typed in here or arrived
 * from a bank email. That is outside Vite's root, which `vite build` handles
 * fine but the dev server refuses to serve without being told.
 */
export default defineConfig({
  // Empty, but required. Cloudflare's build step rewrites this config to add
  // its own plugin, and it fails with "could not find a valid plugins array"
  // if there is nothing to add to. Deleting this line breaks the deploy, not
  // the local build — so nothing here would catch it.
  plugins: [],

  server: {
    fs: { allow: ['..'] },
  },
});
