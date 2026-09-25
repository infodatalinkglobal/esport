'use client';

/**
 * The dashboard's shared client state (MODULE 4).
 *
 * One provider inside the admin layout owns everything every tab needs:
 *
 *   - the organizer's secret for this tab session (login/logout/verify),
 *   - the tournament list for the picker, and
 *   - which tournament is selected (persisted per tab, so switching tabs
 *     keeps the organizer looking at the same tournament).
 *
 * Pages fetch their own data with `adminFetch(path, secret)` and call
 * `logout()` on a 401, which drops the secret and puts the login form back.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AdminTournamentSummary } from '@/types';
import {
  adminFetch,
  clearStoredAdminSecret,
  getStoredAdminSecret,
  getStoredAdminTournament,
  storeAdminSecret,
  storeAdminTournament,
} from '@/lib/admin-client';

/** What `useAdmin()` exposes. */
interface AdminContextValue {
  /** 'checking' while a stored secret is being verified on mount. */
  auth: 'checking' | 'logged-out' | 'logged-in';
  /** Logs in with a secret; resolves to an error message on failure. */
  login: (secret: string) => Promise<string | null>;
  /** Forgets the secret and returns to the login form. */
  logout: () => void;
  /** The organizer's secret (only while logged in). */
  secret: string | null;
  /** Every tournament, newest first — the picker's data. */
  tournaments: AdminTournamentSummary[];
  /** The selected tournament's id, once known. */
  selectedId: string | null;
  /** Changes the selected tournament (persists per tab). */
  selectTournament: (id: string) => void;
  /** Re-fetches the tournament list (after create/edit/draw actions). */
  reloadTournaments: () => Promise<void>;
}

const AdminContext = createContext<AdminContextValue | null>(null);

/**
 * Wraps the admin pages with the shared state.
 *
 * @param props.children The admin page being rendered.
 */
export function AdminProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<'checking' | 'logged-out' | 'logged-in'>('checking');
  const [secret, setSecret] = useState<string | null>(null);
  const [tournaments, setTournaments] = useState<AdminTournamentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /** Loads the picker data and the initial selection. */
  const loadTournaments = useCallback(async (currentSecret: string) => {
    const result = await adminFetch<{ overview: { tournaments: AdminTournamentSummary[]; tournament: { id: string } } }>(
      '/api/admin/overview',
      currentSecret,
    );

    if (!result.ok || !result.data) {
      if (result.status === 401) {
        clearStoredAdminSecret();
        setSecret(null);
        setAuth('logged-out');
      }
      return;
    }

    const list = result.data.overview.tournaments ?? [];
    setTournaments(list);

    // Prefer the remembered selection, else whatever the server calls active.
    const remembered = getStoredAdminTournament();
    const stillExists = remembered && list.some((item) => item.tournament.id === remembered);
    const next = stillExists ? remembered : result.data.overview.tournament.id;
    setSelectedId(next);
    if (!stillExists) storeAdminTournament(next);
  }, []);

  // On mount: verify a remembered secret before letting anything render data.
  useEffect(() => {
    const stored = getStoredAdminSecret();
    if (!stored) {
      setAuth('logged-out');
      return;
    }

    let cancelled = false;
    (async () => {
      const check = await adminFetch('/api/admin/verify', stored, { method: 'POST' });
      if (cancelled) return;
      if (check.ok) {
        setSecret(stored);
        setAuth('logged-in');
        await loadTournaments(stored);
      } else {
        clearStoredAdminSecret();
        setAuth('logged-out');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadTournaments]);

  /**
   * Verifies a fresh secret and stores it for the tab session.
   *
   * @param candidate The secret typed in the login form.
   * @returns An error message, or null on success.
   */
  const login = useCallback(
    async (candidate: string): Promise<string | null> => {
      const check = await adminFetch('/api/admin/verify', candidate, { method: 'POST' });
      if (!check.ok) {
        return check.error ?? 'That admin secret is not correct.';
      }
      storeAdminSecret(candidate);
      setSecret(candidate);
      setAuth('logged-in');
      await loadTournaments(candidate);
      return null;
    },
    [loadTournaments],
  );

  /** Forgets the secret (also used by pages on a 401). */
  const logout = useCallback(() => {
    clearStoredAdminSecret();
    setSecret(null);
    setTournaments([]);
    setSelectedId(null);
    setAuth('logged-out');
  }, []);

  /**
   * Remembers a new picker selection.
   *
   * @param id The tournament id that was picked.
   */
  const selectTournament = useCallback((id: string) => {
    storeAdminTournament(id);
    setSelectedId(id);
  }, []);

  const reloadTournaments = useCallback(async () => {
    if (secret) await loadTournaments(secret);
  }, [secret, loadTournaments]);

  const value = useMemo<AdminContextValue>(
    () => ({
      auth,
      login,
      logout,
      secret,
      tournaments,
      selectedId,
      selectTournament,
      reloadTournaments,
    }),
    [auth, login, logout, secret, tournaments, selectedId, selectTournament, reloadTournaments],
  );

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

/**
 * The hook every admin page uses to reach the shared state.
 *
 * @returns The dashboard's shared state (see {@link AdminContextValue}).
 * @throws When used outside {@link AdminProvider} (a wiring mistake).
 */
export function useAdmin(): AdminContextValue {
  const context = useContext(AdminContext);
  if (!context) {
    throw new Error('useAdmin must be used inside the admin layout');
  }
  return context;
}
