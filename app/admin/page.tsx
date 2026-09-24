'use client';

/**
 * /admin — the Overview tab (MODULE 4).
 *
 * The organizer's one glance at a tournament:
 *   - the money: paid players, pending payments, revenue, prize split,
 *   - the football: group-stage and knockout progress,
 *   - the levers: every lifecycle action (close/reopen registration, draw
 *     groups, draw knockout, reset the group stage, mark completed),
 *   - the pulse: the newest registrations.
 *
 * Every action button's availability (and its disabled reason) arrives
 * pre-computed from the server, which derives it with the tested rules in
 * `lib/admin-rules.ts` — the UI never second-guesses them.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AdminOverview, TournamentStatus } from '@/types';
import { useAdmin } from '@/components/admin/admin-context';
import { Banner, ConfirmButton, PaymentBadge, StatCard } from '@/components/admin/ui';
import { adminFetch } from '@/lib/admin-client';
import { formatCedis } from '@/lib/calculations';
import { formatDateTime } from '@/lib/format';

/** What a lifecycle action's handler resolves to. */
type ActionResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * The Overview page.
 *
 * @returns The stats grid, lifecycle actions and recent sign-ups.
 */
export default function AdminOverviewPage() {
  const { secret, selectedId, logout, reloadTournaments } = useAdmin();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  /** (Re)loads the overview for the selected tournament. */
  const load = useCallback(async () => {
    if (!secret || !selectedId) return;
    setLoading(true);
    const result = await adminFetch<{ overview: AdminOverview }>(
      `/api/admin/overview?tournament_id=${encodeURIComponent(selectedId)}`,
      secret,
    );
    setLoading(false);

    if (result.status === 401) {
      logout();
      return;
    }
    if (!result.ok || !result.data) {
      setUnavailable(result.error ?? 'The overview could not be loaded.');
      return;
    }
    setUnavailable(null);
    setOverview(result.data.overview);
  }, [secret, selectedId, logout]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Runs one lifecycle action, then refreshes everything it may have changed.
   *
   * @param key The action's key (for the busy marker).
   * @param path The API path.
   * @param body The request body.
   * @param successMessage What the banner says when it worked.
   */
  async function runAction(
    key: string,
    path: string,
    body: Record<string, unknown>,
    successMessage: string,
  ) {
    if (!secret || !overview) return;
    setBusyAction(key);
    const result = await adminFetch<{ deleted?: { results: number } }>(path, secret, {
      method: 'POST',
      body,
    });
    setBusyAction(null);

    if (result.status === 401) {
      logout();
      return;
    }

    const outcome: ActionResult = result.ok
      ? { ok: true, message: successMessage }
      : { ok: false, message: result.error ?? 'That did not work. Please try again.' };
    setBanner({ tone: outcome.ok ? 'ok' : 'error', text: outcome.message });

    if (outcome.ok) {
      await Promise.all([load(), reloadTournaments()]);
    }
  }

  /**
   * Changes the tournament's status (close / reopen / complete).
   *
   * @param status The target status.
   * @param message The success message.
   */
  async function changeStatus(status: TournamentStatus, message: string) {
    if (!secret || !overview) return;
    setBusyAction(`status-${status}`);
    const result = await adminFetch('/api/admin/tournaments', secret, {
      method: 'PATCH',
      body: { id: overview.tournament.id, status },
    });
    setBusyAction(null);

    if (result.status === 401) {
      logout();
      return;
    }

    setBanner(
      result.ok
        ? { tone: 'ok', text: message }
        : { tone: 'error', text: result.error ?? 'That did not work. Please try again.' },
    );
    if (result.ok) {
      await Promise.all([load(), reloadTournaments()]);
    }
  }

  if (!selectedId && !loading) {
    return (
      <div className="acard">
        <h1 className="text-lg font-bold text-slate-900">No tournaments yet</h1>
        <p className="mt-1 text-sm text-slate-600">
          Create the first one on the <span className="text-slate-800">Tournament</span> tab.
        </p>
      </div>
    );
  }

  if (loading && !overview) {
    return <p className="text-sm font-medium text-slate-500">Loading the overview…</p>;
  }

  if (unavailable || !overview) {
    return (
      <div className="flex flex-col gap-3">
        <Banner tone="error">{unavailable ?? 'The overview could not be loaded.'}</Banner>
        <button type="button" className="abtn-secondary max-w-xs" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  const { tournament, payment_counts, prizes, group_matches, knockout_matches, actions } = overview;
  const fillPercent = Math.round((payment_counts.paid / Math.max(1, tournament.max_players)) * 100);
  const groupDone = group_matches.total
    ? Math.round((group_matches.completed / group_matches.total) * 100)
    : 0;

  return (
    <div className="flex flex-col gap-6">
      {/* --- The tournament's identity card ------------------------------- */}
      <section className="acard flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-extrabold text-slate-900 sm:text-2xl">{tournament.title}</h1>
            <p className="mt-1 text-sm text-slate-600">
              {formatCedis(tournament.entry_fee)} entry · {tournament.max_players} slots ·{' '}
              <span className="font-semibold text-slate-900">{tournament.status}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            ↻ Refresh
          </button>
        </div>
        <dl className="grid grid-cols-1 gap-2 text-sm text-slate-600 sm:grid-cols-2">
          <div>
            <dt className="inline font-medium text-slate-700">Registration closes: </dt>
            <dd className="inline">{formatDateTime(tournament.registration_deadline)}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-slate-700">Matches due by: </dt>
            <dd className="inline">{formatDateTime(tournament.match_deadline)}</dd>
          </div>
        </dl>
      </section>

      {banner ? <Banner tone={banner.tone}>{banner.text}</Banner> : null}

      {/* --- The money ------------------------------------------------------ */}
      <section aria-labelledby="stats-heading">
        <h2 id="stats-heading" className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">
          Money & players
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            value={`${payment_counts.paid}/${tournament.max_players}`}
            label="Paid players"
            sub={`${fillPercent}% full`}
            accent
          />
          <StatCard
            value={payment_counts.pending}
            label="Awaiting payment"
            sub={
              payment_counts.refunded > 0
                ? `${payment_counts.refunded} refunded`
                : undefined
            }
          />
          <StatCard value={formatCedis(overview.revenue_pesewas)} label="Collected" accent />
          <StatCard
            value={formatCedis(prizes.winnerPrize)}
            label="Winner takes"
            sub={`Runner-up ${formatCedis(prizes.runnerUpPrize)} · Org ${formatCedis(prizes.organizerShare)}`}
          />
        </div>
      </section>

      {/* --- The football ---------------------------------------------------- */}
      <section aria-labelledby="progress-heading">
        <h2 id="progress-heading" className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">
          Progress
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="acard">
            <p className="text-sm font-semibold text-slate-700">Group stage</p>
            <p className="mt-1 text-2xl font-extrabold tabular-nums text-slate-900">
              {group_matches.completed}
              <span className="text-base font-bold text-slate-500">/{group_matches.total} played</span>
            </p>
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"
              role="progressbar"
              aria-valuenow={groupDone}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Group stage progress"
            >
              <div className="h-full rounded-full bg-pitch-500" style={{ width: `${groupDone}%` }} />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {group_matches.disputed} disputed · {group_matches.pending} waiting for results
            </p>
          </div>
          <div className="acard">
            <p className="text-sm font-semibold text-slate-700">Knockout</p>
            <p className="mt-1 text-2xl font-extrabold tabular-nums text-slate-900">
              {knockout_matches.completed}
              <span className="text-base font-bold text-slate-500">/{knockout_matches.total} played</span>
            </p>
            <p className="mt-2 text-xs text-slate-500">
              {tournament.status === 'bracket_drawn' || tournament.status === 'completed'
                ? `${knockout_matches.disputed} disputed · ${knockout_matches.pending} waiting`
                : 'Drawn after every group match has a result.'}
            </p>
          </div>
        </div>
      </section>

      {/* --- The levers -------------------------------------------------------- */}
      <section aria-labelledby="actions-heading">
        <h2 id="actions-heading" className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">
          Tournament actions
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ConfirmButton
            label={tournament.status === 'open' ? 'Close registration' : 'Registration closed'}
            confirmLabel="Really close registration?"
            disabled={!actions.close_registration.allowed}
            reason={actions.close_registration.reason}
            busy={busyAction === 'status-closed'}
            onConfirm={() => void changeStatus('closed', 'Registration is now closed.')}
          />
          <ConfirmButton
            label="Reopen registration"
            confirmLabel="Really reopen registration?"
            disabled={!actions.reopen_registration.allowed}
            reason={actions.reopen_registration.reason}
            busy={busyAction === 'status-open'}
            onConfirm={() => void changeStatus('open', 'Registration is open again.')}
          />
          <ConfirmButton
            label="Draw groups"
            confirmLabel="Draw the groups now?"
            disabled={!actions.draw_groups.allowed}
            reason={actions.draw_groups.reason}
            busy={busyAction === 'draw-groups'}
            onConfirm={() =>
              void runAction(
                'draw-groups',
                '/api/admin/draw-groups',
                { tournament_id: tournament.id },
                'Groups drawn — fixtures are live.',
              )
            }
          />
          <ConfirmButton
            label="Draw knockout"
            confirmLabel="Draw semifinals & final?"
            disabled={!actions.draw_knockout.allowed}
            reason={actions.draw_knockout.reason}
            busy={busyAction === 'draw-knockout'}
            onConfirm={() =>
              void runAction(
                'draw-knockout',
                '/api/admin/draw-knockout',
                { tournament_id: tournament.id },
                'Semifinals and Grand Final are live.',
              )
            }
          />
          <ConfirmButton
            label="Reset group stage"
            confirmLabel={
              actions.reset_group_stage.reason?.startsWith('Destroys')
                ? 'Really delete results & groups?'
                : 'Really delete the groups?'
            }
            disabled={!actions.reset_group_stage.allowed}
            reason={actions.reset_group_stage.reason}
            danger
            busy={busyAction === 'reset'}
            onConfirm={() =>
              void runAction(
                'reset',
                '/api/admin/reset-group-stage',
                { tournament_id: tournament.id, reopen: true },
                'Group stage deleted — the tournament is open for a new draw.',
              )
            }
          />
          <ConfirmButton
            label="Mark completed"
            confirmLabel="Really complete this tournament?"
            disabled={!actions.mark_completed.allowed}
            reason={actions.mark_completed.reason}
            busy={busyAction === 'status-completed'}
            onConfirm={() =>
              void changeStatus('completed', 'Tournament completed — it is on the Champions page.')
            }
          />
        </div>
      </section>

      {/* --- The pulse ----------------------------------------------------------- */}
      <section aria-labelledby="recent-heading">
        <h2 id="recent-heading" className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">
          Recent registrations
        </h2>
        <div className="acard overflow-x-auto p-0">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th scope="col" className="px-4 py-3 font-semibold">Player</th>
                <th scope="col" className="px-4 py-3 font-semibold">Team</th>
                <th scope="col" className="px-4 py-3 font-semibold">Payment</th>
                <th scope="col" className="px-4 py-3 font-semibold">Date</th>
              </tr>
            </thead>
            <tbody>
              {overview.recent_registrations.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                    Nobody has registered yet.
                  </td>
                </tr>
              ) : (
                overview.recent_registrations.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 font-semibold text-slate-900">{row.player_name}</td>
                    <td className="px-4 py-3 text-slate-600">{row.dls_team_name}</td>
                    <td className="px-4 py-3">
                      <PaymentBadge status={row.payment_status} />
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-500">{row.registered_at}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Full list with contacts on the <span className="text-slate-700">Players</span> tab.
        </p>
      </section>
    </div>
  );
}
