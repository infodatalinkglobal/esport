/**
 * The fixture list for one group.
 *
 * Every fixture card shows Player A vs Player B, the score once it is known, and
 * the status badge (🟡 Pending | ✅ Completed | 🔴 Disputed). Cards stack
 * vertically for thumbs — there is no side-by-side layout on mobile.
 */

import type { GroupFixturesProps } from '@/types';
import {
  matchStatusClasses,
  matchStatusEmoji,
  matchStatusLabel,
} from '@/lib/format';

/**
 * Renders every fixture of a single group.
 *
 * @param props.fixtures The group's fixtures, sorted by match number.
 */
export default function GroupFixtures({ fixtures }: GroupFixturesProps) {
  if (fixtures.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No fixtures have been generated for this group yet.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {fixtures.map((fixture) => {
        const hasScore =
          fixture.status === 'completed' &&
          fixture.player_a_score !== null &&
          fixture.player_b_score !== null;

        return (
          <li
            key={fixture.id}
            className="rounded-xl border border-white/10 bg-slate-900/50 p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Match {fixture.match_number}
              </span>
              <span className={`badge ${matchStatusClasses(fixture.status)}`}>
                <span aria-hidden="true" className="mr-1">
                  {matchStatusEmoji(fixture.status)}
                </span>
                {matchStatusLabel(fixture.status)}
              </span>
            </div>

            {/* The scoreline once confirmed, otherwise "vs". */}
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-white">
                  {fixture.player_a_name}
                </p>
                <p className="truncate text-xs text-slate-400">
                  {fixture.player_a_team}
                </p>
              </div>

              <div className="shrink-0 text-center">
                {hasScore ? (
                  <span className="text-lg font-bold tabular-nums text-pitch-400">
                    {fixture.player_a_score} - {fixture.player_b_score}
                  </span>
                ) : (
                  <span className="text-sm font-semibold text-slate-500">
                    vs
                  </span>
                )}
              </div>

              <div className="min-w-0 flex-1 text-right">
                <p className="truncate font-semibold text-white">
                  {fixture.player_b_name}
                </p>
                <p className="truncate text-xs text-slate-400">
                  {fixture.player_b_team}
                </p>
              </div>
            </div>

            {fixture.status === 'completed' && fixture.winner_name ? (
              <p className="mt-1.5 text-xs font-medium text-pitch-400">
                Winner: {fixture.winner_name}
              </p>
            ) : null}

            {fixture.status === 'completed' && !fixture.winner_name ? (
              <p className="mt-1.5 text-xs font-medium text-slate-400">
                Draw — 1 point each
              </p>
            ) : null}

            {fixture.status === 'disputed' ? (
              <p className="mt-1.5 text-xs font-medium text-red-300">
                Disputed — the organizer will review this within 24 hours.
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
