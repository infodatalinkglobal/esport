/**
 * Player-facing view helpers — pure functions, no database.
 *
 * These put a match into ONE player's perspective ("my score vs their score",
 * "I won / I lost / we drew") for the My Matches page. Opponent names come in
 * pre-resolved from the server; phone numbers never enter this module, so a
 * player can never see who else to contact directly — matches are arranged in
 * the WhatsApp group, exactly like the published rules say.
 */

import type { Bracket, GroupMatch, MatchStatus, PlayerFixtureView } from '@/types';

/** How the player fared in one match. */
export type PlayerOutcome = 'won' | 'lost' | 'draw' | null;

/**
 * Turns one group fixture into a player's view of it.
 *
 * @param match The `group_matches` row.
 * @param playerId The viewing player's `registrations.id`.
 * @param names Lookup of player id → display name.
 * @param teams Lookup of player id → DLS club name.
 * @returns The player's view, or null when they are not in this match.
 */
export function playerGroupFixtureView(
  match: GroupMatch,
  playerId: string,
  names: Record<string, string>,
  teams: Record<string, string> = {},
): PlayerFixtureView | null {
  const isA = match.player_a_id === playerId;
  const isB = match.player_b_id === playerId;
  if (!isA && !isB) return null;

  const myScore = isA ? match.player_a_score : match.player_b_score;
  const opponentScore = isA ? match.player_b_score : match.player_a_score;
  const opponentId = isA ? match.player_b_id : match.player_a_id;

  return {
    match_id: match.id,
    match_number: match.match_number,
    round_label: null,
    opponent_name: names[opponentId] ?? 'Unknown player',
    opponent_team: teams[opponentId] ?? null,
    my_score: myScore,
    opponent_score: opponentScore,
    status: match.status,
    outcome: confirmedOutcome(match.status, match.winner_id, playerId),
    i_submitted: Boolean(isA ? match.player_a_screenshot : match.player_b_screenshot),
    opponent_submitted: Boolean(isA ? match.player_b_screenshot : match.player_a_screenshot),
  };
}

/**
 * Turns one knockout match into a player's view of it.
 *
 * @param match The `brackets` row (names already resolved by the caller).
 * @param playerId The viewing player's `registrations.id`.
 * @param opponentName Opponent display name (resolved upstream).
 * @param opponentTeam Opponent DLS club name (resolved upstream).
 * @param roundLabel Human label, e.g. 'Semifinal 1'.
 * @returns The player's view, or null when they are not in this match.
 */
export function playerKnockoutFixtureView(
  match: Bracket,
  playerId: string,
  opponentName: string | null,
  opponentTeam: string | null,
  roundLabel: string,
): PlayerFixtureView | null {
  const isA = match.player_a_id === playerId;
  const isB = match.player_b_id === playerId;
  if (!isA && !isB) return null;

  return {
    match_id: match.id,
    match_number: null,
    round_label: roundLabel,
    opponent_name: opponentName ?? 'Waiting for the previous round',
    opponent_team: opponentTeam,
    my_score: null,
    opponent_score: null,
    status: match.status,
    outcome: confirmedOutcome(match.status, match.winner_id, playerId),
    i_submitted: Boolean(isA ? match.player_a_screenshot : match.player_b_screenshot),
    opponent_submitted: Boolean(isA ? match.player_b_screenshot : match.player_a_screenshot),
  };
}

/**
 * A match's confirmed outcome from one player's perspective.
 *
 * @param status The match status.
 * @param winnerId The confirmed winner (null for a draw / undecided).
 * @param playerId The viewing player's id.
 * @returns 'won' | 'lost' | 'draw', or null while the match is undecided.
 */
export function confirmedOutcome(
  status: MatchStatus,
  winnerId: string | null,
  playerId: string,
): PlayerOutcome {
  if (status !== 'completed') return null;
  if (!winnerId) return 'draw';
  return winnerId === playerId ? 'won' : 'lost';
}

/**
 * 1 → '1st', 2 → '2nd', 3 → '3rd', 4 → '4th', 11 → '11th', 21 → '21st'.
 *
 * @param position Any positive integer.
 * @returns The position with its English ordinal suffix.
 */
export function ordinal(position: number): string {
  if (!Number.isInteger(position) || position <= 0) return String(position);
  const remainder100 = position % 100;
  if (remainder100 >= 11 && remainder100 <= 13) return `${position}th`;
  switch (position % 10) {
    case 1:
      return `${position}st`;
    case 2:
      return `${position}nd`;
    case 3:
      return `${position}rd`;
    default:
      return `${position}th`;
  }
}
