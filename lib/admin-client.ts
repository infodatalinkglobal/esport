/**
 * The dashboard's browser helper — client-safe (imports nothing server-only).
 *
 * Two jobs:
 * 1. keep the organizer's secret for the length of the session, and
 * 2. attach it to every dashboard API call as the `x-admin-secret` header,
 *    the same header the existing admin endpoints already accept.
 *
 * `sessionStorage` (not localStorage) is deliberate: the secret dies with the
 * browser tab, so an organizer leaving a phone unlocked never leaves a
 * long-lived key behind.
 */

/** sessionStorage key for the organizer's secret. */
export const ADMIN_SECRET_STORAGE_KEY = 'dls-admin-secret';

/** sessionStorage key for the organizer's selected tournament id. */
export const ADMIN_TOURNAMENT_STORAGE_KEY = 'dls-admin-tournament';

/**
 * Reads the secret kept for this tab session.
 *
 * @returns The secret, or null when the organizer has not logged in.
 */
export function getStoredAdminSecret(): string | null {
  try {
    return window.sessionStorage.getItem(ADMIN_SECRET_STORAGE_KEY);
  } catch {
    // Private-browsing modes can throw on storage access.
    return null;
  }
}

/**
 * Remembers the secret for this tab session.
 *
 * @param secret The secret typed in the login form.
 */
export function storeAdminSecret(secret: string): void {
  try {
    window.sessionStorage.setItem(ADMIN_SECRET_STORAGE_KEY, secret);
  } catch {
    // Storage unavailable — the dashboard still works until the next reload.
  }
}

/**
 * Forgets the secret (logout).
 */
export function clearStoredAdminSecret(): void {
  try {
    window.sessionStorage.removeItem(ADMIN_SECRET_STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}

/**
 * Remembers which tournament the organizer is looking at.
 *
 * @param tournamentId The selected tournament's id.
 */
export function storeAdminTournament(tournamentId: string): void {
  try {
    window.sessionStorage.setItem(ADMIN_TOURNAMENT_STORAGE_KEY, tournamentId);
  } catch {
    // Selection simply won't persist.
  }
}

/**
 * Reads the remembered tournament selection.
 *
 * @returns The tournament id, or null when nothing was selected yet.
 */
export function getStoredAdminTournament(): string | null {
  try {
    return window.sessionStorage.getItem(ADMIN_TOURNAMENT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** What {@link adminFetch} resolves to. */
export interface AdminFetchResult<T> {
  /** True when the server answered 2xx. */
  ok: boolean;
  /** The HTTP status code (0 when the request never left the browser). */
  status: number;
  /** The parsed JSON body, or null when there was none. */
  data: T | null;
  /** The `error` message from a failing body, when present. */
  error: string | null;
}

/**
 * Calls a dashboard API route with the secret attached.
 *
 * @param path The API path, e.g. '/api/admin/overview'.
 * @param secret The organizer's secret (sent as `x-admin-secret`).
 * @param init Extra fetch options — `body` should be a plain object.
 * @returns The status plus the parsed body, so pages can react to 401s.
 */
export async function adminFetch<T>(
  path: string,
  secret: string,
  init: { method?: string; body?: unknown } = {},
): Promise<AdminFetchResult<T>> {
  try {
    const response = await fetch(path, {
      method: init.method ?? 'GET',
      headers: {
        'x-admin-secret': secret,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
    });

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    const body = data as { error?: string } | null;
    return {
      ok: response.ok,
      status: response.status,
      data: response.ok ? (data as T) : null,
      error: body?.error ?? null,
    };
  } catch {
    return { ok: false, status: 0, data: null, error: 'Network error — check your connection.' };
  }
}
