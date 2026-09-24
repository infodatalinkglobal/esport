/**
 * My Matches (/my-matches?phone=0241234567)
 *
 * The player types the WhatsApp number they registered with and sees
 * everything about themselves in one place, from their own perspective:
 *
 * - payment status and group position (same tiebreakers as the standings page)
 * - every group fixture: opponent, "my score vs theirs", pending/disputed
 * - every knockout match with its round label
 * - a submit-result shortcut straight into their open fixtures
 *
 * Privacy: the number identifies the player, but no phone numbers come back
 * from the server — opponents appear as names only, and matches are arranged
 * in the WhatsApp group per the published rules.
 *
 * The lookup is a plain GET form, so it works before any JavaScript loads and
 * the result is shareable/bookmarkable via the URL.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { getPlayerDashboard } from '@/lib/data';
import { ordinal } from '@/lib/player-view';
import { matchStatusClasses, matchStatusEmoji, matchStatusLabel } from '@/lib/format';
import { whatsappLink } from '@/lib/format';
import type { PlayerFixtureView, PlayerTournamentView } from '@/types';

/** Live registration state — never cache. */
export const dynamic = 'force-dynamic';

/** Page metadata. */
export const metadata: Metadata = {
  title: 'My Matches',
  description:
    'See your group position, fixtures and knockout matches for the DLS tournament.',
};

/** Props passed by Next.js. */
interface MyMatchesPageProps {
  searchParams: {
    /** The WhatsApp number the player registered with. */
    phone?: string;
  };
}

/**
 * The outcome chip shown once a result is confirmed.
 *
 * @param outcome The player's outcome in the match.
 */
function OutcomeChip({ outcome }: { outcome: 'won' | 'lost' | 'draw' | null }) {
  if (outcome === null) return null;

  const styles =
    outcome === 'won'
      ? 'bg-pitch-500/15 text-pitch-400 border-pitch-500/40'
      : outcome === 'lost'
        ? 'bg-red-500/15 text-red-300 border-red-500/40'
        : 'bg-white/10 text-slate-300 border-white/20';

  const label = outcome === 'won' ? 'Won' : outcome === 'lost' ? 'Lost' : 'Draw';

  return (
    <span className={`badge shrink-0 ${styles}`}>
      {outcome === 'won' ? '✅' : outcome === 'lost' ? '❌' : '🤝'} {label}
    </span>
  );
}

/**
 * One match row, from the player's perspective.
 *
 * @param fixture The player's view of the match.
 */
function MatchRow({ fixture }: { fixture: PlayerFixtureView }) {
  const pendingProof =
    fixture.status === 'pending' &&
    (fixture.i_submitted || fixture.opponent_submitted);

  return (
    <li className="rounded-xl border border-white/10 bg-slate-900/50 p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {fixture.round_label ?? `Match ${fixture.match_number ?? '?'}`}
        </span>
        <span className={`badge ${matchStatusClasses(fixture.status)}`}>
          <span aria-hidden="true" className="mr-1">
            {matchStatusEmoji(fixture.status)}
          </span>
          {matchStatusLabel(fixture.status)}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">
            {fixture.opponent_name}
          </p>
          {fixture.opponent_team ? (
            <p className="truncate text-xs text-slate-400">
              {fixture.opponent_team}
            </p>
          ) : null}
        </div>

        {fixture.my_score !== null ? (
          <span className="shrink-0 text-lg font-bold tabular-nums text-pitch-400">
            {fixture.my_score} - {fixture.opponent_score}
          </span>
        ) : (
          <span className="shrink-0 text-sm font-semibold text-slate-500">
            vs
          </span>
        )}

        <div className="flex shrink-0 justify-end">
          <OutcomeChip outcome={fixture.outcome} />
        </div>
      </div>

      {fixture.status === 'disputed' ? (
        <p className="mt-1.5 text-xs font-medium text-red-300">
          Disputed — the organizer will review this within 24 hours.
        </p>
      ) : pendingProof ? (
        <p className="mt-1.5 text-xs text-slate-400">
          {fixture.i_submitted
            ? 'Your result is in — waiting for your opponent to submit the same score.'
            : 'Your opponent submitted — submit your result to confirm or dispute it.'}
        </p>
      ) : null}
    </li>
  );
}

/**
 * One tournament section of the dashboard.
 *
 * @param view The player's data for one tournament.
 */
function TournamentCard({ view }: { view: PlayerTournamentView }) {
  const openFixtures =
    view.group_fixtures.filter((f) => f.status === 'pending').length +
    view.knockout_matches.filter((f) => f.status === 'pending').length;

  return (
    <section className="card space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-bold text-white">
            {view.tournament.title}
          </h2>
          <p className="mt-0.5 text-sm text-slate-400">
            {view.dls_team_name}
          </p>
        </div>
        <span
          className={`badge shrink-0 ${
            view.payment_status === 'paid'
              ? 'bg-pitch-500/15 text-pitch-400 border-pitch-500/40'
              : 'bg-amber-500/15 text-amber-200 border-amber-500/40'
          }`}
        >
          {view.payment_status === 'paid' ? '✅ Paid' : '⏳ Payment pending'}
        </span>
      </header>

      {/* Group standing */}
      {view.group_name ? (
        <p className="rounded-xl bg-white/5 px-3 py-2 text-sm text-slate-200">
          {view.group_position !== null ? (
            <>
              <strong className="text-white">
                {ordinal(view.group_position)}
              </strong>{' '}
              in Group {view.group_name}
              {view.group_position !== null && view.group_position <= 2 ? (
                <span className="ml-1 text-pitch-400">
                  — advancing to the knockout stage
                </span>
              ) : null}
            </>
          ) : (
            <>Group {view.group_name}</>
          )}
        </p>
      ) : (
        <p className="rounded-xl bg-white/5 px-3 py-2 text-sm text-slate-400">
          Groups have not been drawn yet — check back once every slot is paid.
        </p>
      )}

      {/* Group fixtures */}
      {view.group_fixtures.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Group fixtures
          </h3>
          <ul className="space-y-2">
            {view.group_fixtures.map((fixture) => (
              <MatchRow key={fixture.match_id} fixture={fixture} />
            ))}
          </ul>
        </div>
      ) : null}

      {/* Knockout matches */}
      {view.knockout_matches.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Knockout matches
          </h3>
          <ul className="space-y-2">
            {view.knockout_matches.map((fixture) => (
              <MatchRow key={fixture.match_id} fixture={fixture} />
            ))}
          </ul>
        </div>
      ) : null}

      {/* Actions */}
      <div className="space-y-2">
        <Link
          href={`/submit-result?tournament=${view.tournament.id}`}
          className="btn-primary"
        >
          Submit a result{openFixtures > 0 ? ` (${openFixtures} open)` : ''}
        </Link>
        {view.group_name ? (
          <Link href={`/groups/${view.tournament.id}`} className="btn-secondary">
            Full group tables
          </Link>
        ) : null}
        {view.knockout_matches.length > 0 ? (
          <Link
            href={`/bracket/${view.tournament.id}`}
            className="btn-secondary"
          >
            Knockout bracket
          </Link>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Renders the My Matches lookup and dashboard.
 *
 * @param props.searchParams May contain the player's WhatsApp number.
 */
export default async function MyMatchesPage({ searchParams }: MyMatchesPageProps) {
  const rawPhone = (searchParams.phone ?? '').trim();

  // No lookup yet: show the form.
  if (!rawPhone) {
    return (
      <div className="space-y-5">
        <header className="space-y-1">
          <h1 className="text-xl font-bold text-white">My Matches</h1>
          <p className="text-sm text-slate-400">
            Your fixtures, results and group position in one place.
          </p>
        </header>

        <form method="GET" action="/my-matches" className="card space-y-4">
          <div>
            <label className="field-label" htmlFor="phone">
              Your WhatsApp number
            </label>
            <input
              id="phone"
              name="phone"
              className="field"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              placeholder="0241234567"
              required
            />
            <p className="mt-1 text-xs text-slate-500">
              The number you registered with, e.g. 0241234567.
            </p>
          </div>
          <button type="submit" className="btn-primary">
            Show my matches
          </button>
        </form>
      </div>
    );
  }

  const views = await getPlayerDashboard(rawPhone);

  if (views.length === 0) {
    return (
      <div className="space-y-4">
        <header className="space-y-1">
          <h1 className="text-xl font-bold text-white">My Matches</h1>
        </header>

        <div className="card border-amber-500/40 bg-amber-500/10">
          <h2 className="text-base font-semibold text-amber-200">
            Nothing found for {rawPhone}
          </h2>
          <p className="mt-1 text-sm text-amber-100">
            No registration uses this number. Check the number, or register from
            the tournament page first.
          </p>
        </div>

        <a
          href={whatsappLink(
            undefined,
            `Hi! My number (${rawPhone}) is not showing my matches.`,
          )}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary"
        >
          Contact organizer on WhatsApp
        </a>

        <Link href="/" className="btn-secondary">
          Back to the tournament
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-bold text-white">
          My Matches — {views[0]?.player_name}
        </h1>
        <p className="text-sm text-slate-400">
          Everything under your number ({rawPhone}). Arrange matches in the
          WhatsApp group — opponent numbers stay private.
        </p>
      </header>

      {views.map((view) => (
        <TournamentCard key={view.tournament.id} view={view} />
      ))}

      <Link href="/" className="btn-secondary">
        Back to the tournament
      </Link>
    </div>
  );
}
