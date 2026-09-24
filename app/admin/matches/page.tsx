'use client';

/**
 * /admin/matches — the Matches tab (MODULE 4).
 *
 * Every fixture of the tournament in one list: group matches and knockout
 * matches, with scores, screenshots and status filter chips. Its day job is
 * the dispute queue — when two players submit conflicting results the match
 * lands in 'disputed', and this page is where the organizer settles it by
 * entering the true scoreline (group) or picking the true winner (knockout).
 *
 * Setting a result does everything an agreed player submission would: the
 * group league table is recalculated, or the knockout winner advances.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { AdminMatchRow, MatchStatus } from '@/types';
import { useAdmin } from '@/components/admin/admin-context';
import { Banner, MatchBadge } from '@/components/admin/ui';
import { adminFetch, downloadCsv } from '@/lib/admin-client';

/** The status filter chips. */
const FILTERS = ['all', 'pending', 'disputed', 'completed'] as const;
type Filter = (typeof FILTERS)[number];

/** One match card's local form state. */
interface ResultFormState {
  score_a: string;
  score_b: string;
  winner_id: string;
}

/**
 * The Matches page.
 *
 * @returns The filterable match list with the result-entry forms.
 */
export default function AdminMatchesPage() {
  const { secret, selectedId, logout } = useAdmin();
  const [matches, setMatches] = useState<AdminMatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [openForm, setOpenForm] = useState<string | null>(null);
  const [form, setForm] = useState<ResultFormState>({ score_a: '', score_b: '', winner_id: '' });
  const [busy, setBusy] = useState(false);

  /** (Re)loads the matches. */
  const load = useCallback(async () => {
    if (!secret || !selectedId) return;
    setLoading(true);
    const result = await adminFetch<{ matches: AdminMatchRow[] }>(
      `/api/admin/matches?tournament_id=${encodeURIComponent(selectedId)}`,
      secret,
    );
    setLoading(false);

    if (result.status === 401) {
      logout();
      return;
    }
    if (!result.ok || !result.data) {
      setFailed(result.error ?? 'The matches could not be loaded.');
      return;
    }
    setFailed(null);
    setMatches(result.data.matches);
  }, [secret, selectedId, logout]);

  useEffect(() => {
    setMatches([]);
    void load();
  }, [load]);

  /** Exports every match of the tournament as CSV. */
  function exportCsv() {
    downloadCsv(
      `matches-${(selectedId ?? 'tournament').slice(0, 8)}.csv`,
      matches.map((match) => ({
        stage: match.kind,
        label: match.label,
        player_a: match.player_a_name,
        player_b: match.player_b_name,
        score: match.kind === 'group' ? `${match.player_a_score ?? ''}-${match.player_b_score ?? ''}` : '',
        winner: match.winner_name ?? '',
        status: match.status,
      })),
    );
  }

  /** The counts shown on the filter chips. */
  const counts = useMemo(() => {
    const base: Record<MatchStatus | 'all', number> = {
      all: matches.length,
      pending: 0,
      completed: 0,
      disputed: 0,
    };
    for (const match of matches) base[match.status] += 1;
    return base;
  }, [matches]);

  /** The rows the current filter shows, group stage first. */
  const visible = useMemo(() => {
    const byFilter =
      filter === 'all' ? matches : matches.filter((match) => match.status === filter);
    const rank = (match: AdminMatchRow) => (match.kind === 'group' ? 0 : 1);
    return [...byFilter].sort((a, b) => rank(a) - rank(b));
  }, [matches, filter]);

  /**
   * Opens (or closes) one match's result form with sensible defaults.
   *
   * @param match The match being settled.
   */
  function toggleForm(match: AdminMatchRow) {
    if (openForm === match.id) {
      setOpenForm(null);
      return;
    }
    setOpenForm(match.id);
    setForm({
      score_a: match.player_a_score?.toString() ?? '',
      score_b: match.player_b_score?.toString() ?? '',
      winner_id: match.winner_id ?? match.player_a_id ?? '',
    });
  }

  /**
   * Submits the result for the match whose form is open.
   *
   * @param event The form submission.
   * @param match The match being settled.
   */
  async function submitResult(event: FormEvent, match: AdminMatchRow) {
    event.preventDefault();
    if (!secret || busy) return;

    const body =
      match.kind === 'group'
        ? {
            kind: 'group',
            match_id: match.id,
            score_a: Number(form.score_a),
            score_b: Number(form.score_b),
          }
        : { kind: 'knockout', match_id: match.id, winner_id: form.winner_id };

    setBusy(true);
    const result = await adminFetch('/api/admin/match-result', secret, {
      method: 'POST',
      body,
    });
    setBusy(false);

    if (result.status === 401) {
      logout();
      return;
    }

    if (result.ok) {
      setBanner({
        tone: 'ok',
        text: `Result saved for “${match.label}”.${
          match.kind === 'knockout' ? ' The winner advanced.' : ' The table was updated.'
        }`,
      });
      setOpenForm(null);
      await load();
    } else {
      setBanner({ tone: 'error', text: result.error ?? 'That did not work. Try again.' });
    }
  }

  if (!selectedId && !loading) {
    return (
      <div className="acard">
        <h1 className="text-lg font-bold text-slate-900">No tournament selected</h1>
        <p className="mt-1 text-sm text-slate-600">Pick a tournament in the header first.</p>
      </div>
    );
  }

  if (loading) {
    return <p className="text-sm font-medium text-slate-500">Loading the matches…</p>;
  }

  if (failed) {
    return (
      <div className="flex flex-col gap-3">
        <Banner tone="error">{failed}</Banner>
        <button type="button" className="abtn-secondary max-w-xs" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-slate-900 sm:text-2xl">Matches</h1>
          <p className="mt-1 text-sm text-slate-600">
            Settle disputes and enter results — standings and the bracket update themselves.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 shadow-sm hover:bg-slate-50"
          >
            ↻ Refresh
          </button>
          <button
            type="button"
            onClick={exportCsv}
            className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 shadow-sm hover:bg-slate-50"
          >
            ⬇ CSV
          </button>
        </div>
      </div>

      {banner ? <Banner tone={banner.tone}>{banner.text}</Banner> : null}

      {/* Filter chips */}
      <div role="tablist" aria-label="Filter by status" className="flex flex-wrap gap-2">
        {FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={filter === option}
            onClick={() => setFilter(option)}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition ${
              filter === option
                ? 'border-pitch-600 bg-pitch-50 text-pitch-700'
                : 'border-slate-300 bg-white text-slate-500 hover:bg-slate-50'
            }`}
          >
            {option} · {counts[option]}
          </button>
        ))}
      </div>

      {/* The match cards */}
      {visible.length === 0 ? (
        <div className="acard py-8 text-center text-sm text-slate-500">
          {matches.length === 0
            ? 'No fixtures yet — draw the groups first.'
            : 'Nothing with that status.'}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {visible.map((match) => (
            <li key={`${match.kind}-${match.id}`} className="acard flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {match.kind === 'group' ? 'Group stage' : 'Knockout'} · {match.label}
                  </p>
                  <p className="mt-1 font-bold text-slate-900">
                    {match.player_a_name}
                    {match.kind === 'group' && match.status === 'completed' ? (
                      <span className="mx-2 rounded-lg bg-slate-100 px-2 py-0.5 tabular-nums">
                        {match.player_a_score} – {match.player_b_score}
                      </span>
                    ) : (
                      <span className="mx-2 text-slate-400">vs</span>
                    )}
                    {match.player_b_name}
                  </p>
                  {match.winner_name ? (
                    <p className="mt-0.5 text-xs font-semibold text-pitch-700">
                      🏆 {match.winner_name}
                    </p>
                  ) : match.status === 'completed' &&
                    match.kind === 'group' &&
                    match.player_a_score === match.player_b_score ? (
                    <p className="mt-0.5 text-xs font-semibold text-slate-600">🤝 Draw</p>
                  ) : null}
                </div>
                <MatchBadge status={match.status} />
              </div>

              {/* Screenshots, when players submitted proof */}
              {(match.player_a_screenshot || match.player_b_screenshot) && (
                <p className="text-xs text-slate-500">
                  Proof:{' '}
                  {match.player_a_screenshot ? (
                    <a
                      className="text-pitch-700 underline underline-offset-2"
                      href={match.player_a_screenshot}
                      target="_blank"
                      rel="noreferrer"
                    >
                      A's screenshot
                    </a>
                  ) : null}
                  {match.player_a_screenshot && match.player_b_screenshot ? ' · ' : ''}
                  {match.player_b_screenshot ? (
                    <a
                      className="text-pitch-700 underline underline-offset-2"
                      href={match.player_b_screenshot}
                      target="_blank"
                      rel="noreferrer"
                    >
                      B's screenshot
                    </a>
                  ) : null}
                </p>
              )}

              {/* Result entry / finality note */}
              {match.status === 'completed' ? (
                <p className="text-xs text-slate-500">Final — recorded results are immutable.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {openForm === match.id ? (
                    <form onSubmit={(event) => void submitResult(event, match)} className="flex flex-col gap-2">
                      {match.kind === 'group' ? (
                        <div className="flex items-end gap-2">
                          <label className="flex-1">
                            <span className="afield-label mb-0.5 text-xs">
                              {match.player_a_name}
                            </span>
                            <input
                              className="afield py-2 text-center tabular-nums"
                              type="number"
                              inputMode="numeric"
                              min={0}
                              max={99}
                              required
                              value={form.score_a}
                              onChange={(event) =>
                                setForm((state) => ({ ...state, score_a: event.target.value }))
                              }
                            />
                          </label>
                          <span className="pb-3 text-slate-500">–</span>
                          <label className="flex-1">
                            <span className="afield-label mb-0.5 text-xs">
                              {match.player_b_name}
                            </span>
                            <input
                              className="afield py-2 text-center tabular-nums"
                              type="number"
                              inputMode="numeric"
                              min={0}
                              max={99}
                              required
                              value={form.score_b}
                              onChange={(event) =>
                                setForm((state) => ({ ...state, score_b: event.target.value }))
                              }
                            />
                          </label>
                        </div>
                      ) : (
                        <label>
                          <span className="afield-label text-xs">Winner</span>
                          <select
                            className="afield py-2 text-sm"
                            required
                            value={form.winner_id}
                            onChange={(event) =>
                              setForm((state) => ({ ...state, winner_id: event.target.value }))
                            }
                          >
                            {match.player_a_id ? (
                              <option value={match.player_a_id}>{match.player_a_name}</option>
                            ) : null}
                            {match.player_b_id ? (
                              <option value={match.player_b_id}>{match.player_b_name}</option>
                            ) : null}
                          </select>
                        </label>
                      )}
                      <div className="flex gap-2">
                        <button type="submit" className="abtn-primary flex-1" disabled={busy}>
                          {busy ? 'Saving…' : 'Save result'}
                        </button>
                        <button
                          type="button"
                          className="abtn-secondary flex-1"
                          onClick={() => setOpenForm(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="abtn-secondary"
                      onClick={() => toggleForm(match)}
                    >
                      {match.status === 'disputed' ? '⚖️ Settle dispute' : 'Enter result'}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
