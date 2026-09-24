/**
 * Supabase clients.
 *
 * | Export                 | Key used     | Where it may run                |
 * |------------------------|--------------|---------------------------------|
 * | `supabaseAdmin()`      | service_role | server only (API routes, pages) |
 * | `supabase()`           | anon         | browser (and read-only server)  |
 * | `isSupabaseConfigured` | –            | anywhere (env sanity check)     |
 *
 * Why these are functions and not module-level constants
 * -----------------------------------------------------
 * Environment variables must be read while handling a request. If a client were
 * built at import time, `next build` (and a fresh `npm run dev` before .env.local
 * exists) would crash with an obscure error before any guard could run. Calling
 * `supabase()` / `supabaseAdmin()` lazily keeps the app bootable and lets the UI
 * show a friendly "not configured yet" message instead.
 *
 * ⚠️ `supabaseAdmin()` bypasses Row Level Security. It must NEVER be imported
 * into a client component — every privileged write (marking payments paid,
 * drawing groups, saving results) uses it on the server.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Next.js extends server-side fetch with a Data Cache. Supabase's REST requests
 * go through fetch, so bypass that cache to keep live database reads fresh.
 */
const noStoreFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, { ...init, cache: 'no-store' });

/** Cached service-role client, created on first use. */
let serviceClient: SupabaseClient | null = null;

/** Cached anon client, created on first use. */
let anonClient: SupabaseClient | null = null;

/**
 * True when the Supabase environment variables needed for server-side reads
 * and writes are present.
 *
 * The UI uses this to show a friendly "not configured" message instead of
 * crashing with an obscure error while the project is being set up.
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

/**
 * The admin Supabase client, authenticated with the service-role key.
 *
 * Bypasses RLS: use it for every privileged write — marking a payment as paid,
 * drawing groups, saving match results — and for server-side reads.
 *
 * @returns A cached `SupabaseClient` using the service-role key.
 * @throws Error when `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`
 *         is missing.
 */
export function supabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local',
    );
  }

  if (!serviceClient) {
    serviceClient = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: noStoreFetch },
    });
  }

  return serviceClient;
}

/**
 * The public Supabase client, authenticated with the anon key.
 *
 * Used in the browser (for example to upload a result screenshot to Storage).
 * Row Level Security limits it to world-readable data plus the few inserts the
 * public is allowed to make, so it is safe to ship to the browser.
 *
 * @returns A cached `SupabaseClient` using the anon key.
 * @throws Error when `NEXT_PUBLIC_SUPABASE_URL` or
 *         `NEXT_PUBLIC_SUPABASE_ANON_KEY` is missing.
 */
export function supabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local',
    );
  }

  if (!anonClient) {
    anonClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  return anonClient;
}
