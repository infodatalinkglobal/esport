'use client';

/**
 * The dashboard's shell (MODULE 4).
 *
 * While the organizer is logged out this renders the login card — one field,
 * the ADMIN_SECRET, verified against /api/admin/verify. While logged in it
 * renders the chrome every tab shares:
 *
 *   - a header with the platform mark, the tournament picker and logout,
 *   - the tab navigation (Overview / Players / Matches / Tournament),
 *   - the page itself underneath.
 *
 * The shell wears the dashboard's own light "back office" skin
 * (`.admin-light`), so it never looks like the player site.
 *
 * The gate is intentionally dumb about data: it owns no rows, so it never
 * needs to refresh when an action changes something.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAdmin } from './admin-context';
import { formatCedis } from '@/lib/calculations';

/** The tabs, in navigation order. */
const TABS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/players', label: 'Players' },
  { href: '/admin/matches', label: 'Matches' },
  { href: '/admin/tournaments', label: 'Tournament' },
] as const;

/**
 * The login card.
 *
 * @returns The secret form, plus the error from a wrong secret.
 */
function LoginForm() {
  const { login } = useAdmin();
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Verifies the typed secret.
   *
   * @param event The form submission.
   */
  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!secret.trim() || busy) return;
    setBusy(true);
    setError(null);
    const failure = await login(secret.trim());
    setBusy(false);
    if (failure) {
      setError(failure);
      setSecret('');
    }
  }

  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <div className="acard flex flex-col gap-4 p-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-pitch-600">
            Organizer only
          </p>
          <h1 className="mt-1 text-2xl font-extrabold text-slate-900">Admin Dashboard</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            Enter the admin secret (<code className="text-slate-800">ADMIN_SECRET</code>) to
            manage tournaments, payments, results and draws.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label htmlFor="admin-secret" className="afield-label">
              Admin secret
            </label>
            <input
              id="admin-secret"
              type="password"
              className="afield"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="Your ADMIN_SECRET"
              autoComplete="current-password"
              required
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm font-medium text-red-600">
              {error}
            </p>
          ) : null}
          <button type="submit" className="abtn-primary" disabled={busy || !secret.trim()}>
            {busy ? 'Checking…' : 'Unlock dashboard'}
          </button>
        </form>

        <p className="text-xs leading-relaxed text-slate-500">
          The secret is kept for this browser tab only and sent as the
          <code className="mx-1 text-slate-600">x-admin-secret</code> header on every request.
        </p>
      </div>
    </main>
  );
}

/**
 * The tournament picker (a plain select — it works on every phone).
 *
 * @returns The select bound to the shared selection state.
 */
function TournamentPicker() {
  const { tournaments, selectedId, selectTournament } = useAdmin();

  if (tournaments.length === 0) return null;

  return (
    <label className="flex w-full max-w-xs flex-col gap-1 sm:w-72">
      <span className="sr-only">Tournament</span>
      <select
        className="afield min-h-0 py-2 text-sm"
        value={selectedId ?? ''}
        onChange={(event) => selectTournament(event.target.value)}
      >
        {tournaments.map(({ tournament, paid_players }) => (
          <option key={tournament.id} value={tournament.id}>
            {tournament.title} · {tournament.status} · {paid_players}/{tournament.max_players} paid
            {' · '}
            {formatCedis(tournament.entry_fee)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The logged-in chrome: header, tabs, page.
 *
 * @param props.children The admin page.
 */
function Shell({ children }: { children: ReactNode }) {
  const { logout } = useAdmin();
  const pathname = usePathname();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="flex items-center justify-between gap-3">
            <Link href="/admin" className="flex items-center whitespace-nowrap text-sm font-bold text-slate-900">
              DLS <span className="ml-1 text-pitch-600">Admin</span>
            </Link>
            <button
              type="button"
              onClick={logout}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 sm:hidden"
            >
              Log out
            </button>
          </div>
          <TournamentPicker />
          <button
            type="button"
            onClick={logout}
            className="hidden rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 sm:block"
          >
            Log out
          </button>
        </div>
        <nav aria-label="Admin sections" className="mx-auto max-w-6xl px-2">
          <ul className="flex gap-1 overflow-x-auto pb-1">
            {TABS.map((tab) => {
              const active =
                tab.href === '/admin' ? pathname === '/admin' : pathname.startsWith(tab.href);
              return (
                <li key={tab.href}>
                  <Link
                    href={tab.href}
                    aria-current={active ? 'page' : undefined}
                    className={`flex min-h-tap items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition ${
                      active
                        ? 'bg-pitch-50 text-pitch-700'
                        : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
                    }`}
                  >
                    {tab.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        {children}
      </main>
    </div>
  );
}

/**
 * Chooses what renders: the login card, a quiet loading state while a stored
 * secret is verified, or the shell with the page.
 *
 * @param props.children The admin page.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const { auth } = useAdmin();

  if (auth === 'checking') {
    return (
      <main id="main" className="mx-auto flex min-h-screen max-w-md items-center justify-center px-4">
        <p className="text-sm font-medium text-slate-500">Checking your session…</p>
      </main>
    );
  }

  if (auth === 'logged-out') return <LoginForm />;

  return <Shell>{children}</Shell>;
}
