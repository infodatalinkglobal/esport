/**
 * One knockout match on the bracket page.
 *
 * The MVP asks for a vertical card stack (no horizontal bracket diagram), so
 * each match is a self-contained, full-width card showing both players, a "VS"
 * divider, the status badge and — once the result is confirmed — the winner in
 * green.
 *
 * While a match is pending, a slot may still be empty ("Waiting for the
 * previous round"); that is normal for the Grand Final before the semifinals
 * have been played.
 */

import type { BracketMatchView } from '@/types';
import {
  matchStatusClasses,
  matchStatusEmoji,
  matchStatusLabel,
} from '@/lib/format';

/** Props for {@link BracketCard}. */
interface BracketCardProps {
  /** The match, with player names already resolved. */
  match: BracketMatchView;
}

/**
 * Renders a single knockout match card.
 *
 * @param props.match The bracket match to show.
 */
export default function BracketCard({ match }: BracketCardProps) {
  const isCompleted = match.status === 'completed';
  const winnerIsA = isCompleted && match.winner_id === match.player_a_id;
  const winnerIsB = isCompleted && match.winner_id === match.player_b_id;

  /**
   * Renders one side of the match.
   *
   * @param name Player name, or null while the slot is undecided.
   * @param team The player's DLS team name.
   * @param isWinner True when this player won the match.
   */
  const renderSide = (
    name: string | null,
    team: string | null,
    isWinner: boolean,
  ) => (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p
          className={
            isWinner
              ? 'truncate text-base font-bold text-pitch-400'
              : 'truncate text-base font-semibold text-white'
          }
        >
          {name ?? (
            <span className="text-sm font-normal italic text-slate-500">
              Waiting for the previous round
            </span>
          )}
        </p>
        {team ? (
          <p className="truncate text-xs text-slate-400">{team}</p>
        ) : null}
      </div>

      {isWinner ? (
        <span className="shrink-0 text-lg" aria-label="Winner">
          ✅
        </span>
      ) : null}
    </div>
  );

  return (
    <article className="rounded-2xl border border-pitch-500/30 bg-white/[0.04] p-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          {match.round_label}
        </h3>
        <span className={`badge ${matchStatusClasses(match.status)}`}>
          <span aria-hidden="true" className="mr-1">
            {matchStatusEmoji(match.status)}
          </span>
          {matchStatusLabel(match.status)}
        </span>
      </header>

      <div className="space-y-2">
        {renderSide(match.player_a_name, match.player_a_team, winnerIsA)}

        <div className="flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-white/10" />
          <span className="text-xs font-bold uppercase text-slate-500">VS</span>
          <span className="h-px flex-1 bg-white/10" />
        </div>

        {renderSide(match.player_b_name, match.player_b_team, winnerIsB)}
      </div>

      {isCompleted && match.winner_name ? (
        <p className="mt-3 rounded-lg bg-pitch-500/10 px-3 py-2 text-sm font-bold text-pitch-400">
          🏆 {match.winner_name} wins
        </p>
      ) : null}

      {match.status === 'disputed' ? (
        <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm font-medium text-red-300">
          Disputed — the two players submitted different results. The organizer
          will review this within 24 hours.
        </p>
      ) : null}

      {match.status === 'pending' &&
      match.player_a_name &&
      match.player_b_name ? (
        <p className="mt-3 text-xs text-slate-500">
          No draws — extra time and penalties decide a level match.
        </p>
      ) : null}
    </article>
  );
}
