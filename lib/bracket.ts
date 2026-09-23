/**
 * MODULE 3 — knockout stage logic.
 *
 * Like `lib/groups.ts`, this file mixes two kinds of code:
 *
 * 1. PURE functions — round labels, the slot a winner advances into, and the
 *    bracket pairings. No database, no network, easy to test.
 *
 * 2. SERVER-ONLY functions that read/write the database with the service-role
 *    client: `getGroupWinners()` and `checkAndResolveMatch()`. Never import this
 *    file into a client component.
 *
 * The format: the top two from each group advance, and the first knockout round
 * crosses the groups so nobody meets a player from their own group straight away.
 *
 *   2 groups (8 players)  → Semifinal 1: A1 v B2,  Semifinal 2: B1 v A2,
 *                           Grand Final
 *   4 groups (16 players) → Quarterfinals: A1 v B2, B1 v A2, C1 v D2, D1 v C2,
 *                           then Semifinals, then the Grand Final
 */

import type {
  Bracket,
  GroupMatch,
  GroupQualifier,
  GroupStanding,
  MatchStatus,
  PublicPlayer,
  Registration,
} from '@/types';
import { isSupabaseConfigured, supabaseAdmin } from './supabase';

/* ==========================================================================
 * 1. Pure bracket maths
 * ========================================================================== */

/**
 * How many knockout rounds a given number of qualifiers needs.
 *
 * @param qualifierCount Players entering the knockout stage (4, 8, ...).
 * @returns Rounds needed — 4 qualifiers → 2 (Semifinals + Grand Final).
 */
export function knockoutRoundCount(qualifierCount: number): number {
  if (qualifierCount < 2) return 0;
  return Math.ceil(Math.log2(qualifierCount));
}

/**
 * The name of a knockout round.
 *
 * @param round 1-based round number (1 = first knockout round).
 * @param totalRounds Total rounds in this tournament's knockout stage.
 * @returns e.g. 'Quarterfinal', 'Semifinal', 'Grand Final'.
 */
export function knockoutRoundLabel(round: number, totalRounds: number): string {
  // The last round is always the Grand Final.
  if (round === totalRounds) return 'Grand Final';
  if (round === totalRounds - 1) return 'Semifinal';
  if (round === totalRounds - 2) return 'Quarterfinal';
  return `Round ${round}`;
}

/**
 * The full label, including the match number inside the round.
 *
 * @param round 1-based round number.
 * @param matchNumber 1-based match number inside the round.
 * @param totalRounds Total rounds in the knockout stage.
 * @returns e.g. "Semifinal 1", or just "Grand Final".
 */
export function knockoutMatchLabel(
  round: number,
  matchNumber: number,
  totalRounds: number,
): string {
  const base = knockoutRoundLabel(round, totalRounds);
  // There is only ever one Grand Final, so it needs no number.
  return base === 'Grand Final' ? base : `${base} ${matchNumber}`;
}

/**
 * Works out where the winner of a knockout match goes next.
 *
 * Matches are paired up as the bracket narrows: match 1 and match 2 feed match 1
 * of the next round (slots A and B), match 3 and 4 feed match 2, and so on.
 *
 * @param match The finished match's round and match number.
 * @returns The destination round, match number and slot ('a' | 'b').
 *
 * @example
 * nextRoundSlot({ round: 1, match_number: 2 }); // { round: 2, match_number: 1, slot: 'b' }
 */
export function nextRoundSlot(match: {
  round: number;
  match_number: number;
}): { round: number; match_number: number; slot: 'a' | 'b' } {
  return {
    round: match.round + 1,
    match_number: Math.ceil(match.match_number / 2),
    // Odd match numbers fill slot A, even ones fill slot B.
    slot: match.match_number % 2 === 1 ? 'a' : 'b',
  };
}

/**
 * Pairs the qualifiers for the first knockout round.
 *
 * Within each pair of groups the winners and runners-up are crossed:
 *   group 1 winner vs group 2 runner-up
 *   group 2 winner vs group 1 runner-up
 *
 * That is what produces "Semifinal 1: Group A 1st vs Group B 2nd" and
 * "Semifinal 2: Group B 1st vs Group A 2nd" for the 8-player format.
 *
 * @param qualifiers The top two players of every group.
 * @returns The pairings, in match-number order. Groups with a missing winner or
 *          runner-up are skipped rather than producing a half-empty match.
 */
export function pairFirstKnockoutRound(
  qualifiers: GroupQualifier[],
): Array<{ playerA: GroupQualifier; playerB: GroupQualifier }> {
  /** Look up "group X, position N" quickly. */
  const find = (group: string, position: number): GroupQualifier | undefined =>
    qualifiers.find(
      (qualifier) =>
        qualifier.group_name === group && qualifier.position === position,
    );

  const groupNames = Array.from(
    new Set(qualifiers.map((qualifier) => qualifier.group_name)),
  ).sort();

  const pairings: Array<{ playerA: GroupQualifier; playerB: GroupQualifier }> =
    [];

  // Walk the groups in pairs: (A, B), then (C, D).
  for (let index = 0; index + 1 < groupNames.length; index += 2) {
    const firstGroup = groupNames[index];
    const secondGroup = groupNames[index + 1];

    const firstGroupWinner = find(firstGroup, 1);
    const secondGroupRunnerUp = find(secondGroup, 2);
    const secondGroupWinner = find(secondGroup, 1);
    const firstGroupRunnerUp = find(firstGroup, 2);

    // Group 1 winner vs group 2 runner-up.
    if (firstGroupWinner && secondGroupRunnerUp) {
      pairings.push({ playerA: firstGroupWinner, playerB: secondGroupRunnerUp });
    }
    // Group 2 winner vs group 1 runner-up.
    if (secondGroupWinner && firstGroupRunnerUp) {
      pairings.push({ playerA: secondGroupWinner, playerB: firstGroupRunnerUp });
    }
  }

  return pairings;
}

/**
 * A bracket row that is ready to be inserted into `brackets`.
 * `player_a_id` / `player_b_id` are null for a placeholder (a later round whose
 * players are still to be decided).
 */
export interface NewBracketRow {
  /** 1-based round number. */
  round: number;
  /** 1-based match number inside the round. */
  match_number: number;
  /** Player A's id, or null for a placeholder slot. */
  player_a_id: string | null;
  /** Player B's id, or null for a placeholder slot. */
  player_b_id: string | null;
  /** Always 'pending' when the bracket is created. */
  status: MatchStatus;
}

/**
 * Builds every knockout match for a tournament.
 *
 * The first round is filled with the qualifiers; the later rounds are created as
 * placeholders (null players) so the bracket page can show the whole route to
 * the final from the moment the draw is published. Winners fill those slots
 * automatically as each round is confirmed.
 *
 * @param qualifiers The top two players of every group.
 * @returns Every row to insert, ordered by round then match number.
 *
 * @example
 * // 2 groups of 4 → 4 qualifiers → 2 semifinals + 1 placeholder final
 * createKnockoutBracket(qualifiers).length; // 3
 */
export function createKnockoutBracket(
  qualifiers: GroupQualifier[],
): NewBracketRow[] {
  const pairings = pairFirstKnockoutRound(qualifiers);
  if (pairings.length === 0) return [];

  const totalRounds = knockoutRoundCount(pairings.length * 2);
  const rows: NewBracketRow[] = [];

  // Round 1: the real matchups.
  pairings.forEach((pairing, index) => {
    rows.push({
      round: 1,
      match_number: index + 1,
      player_a_id: pairing.playerA.player.id,
      player_b_id: pairing.playerB.player.id,
      status: 'pending',
    });
  });

  // Later rounds: placeholders, so the bracket is readable end to end.
  for (let round = 2; round <= totalRounds; round += 1) {
    const matchesInRound = Math.max(1, pairings.length / 2 ** (round - 1));
    for (let matchNumber = 1; matchNumber <= matchesInRound; matchNumber += 1) {
      rows.push({
        round,
        match_number: matchNumber,
        player_a_id: null,
        player_b_id: null,
        status: 'pending',
      });
    }
  }

  return rows;
}

/**
 * Finds the champion: the winner of the final round.
 *
 * @param matches Every knockout match of the tournament.
 * @returns The winner's `registrations.id`, or null while it is undecided.
 */
export function findChampionId(matches: Bracket[]): string | null {
  if (matches.length === 0) return null;

  const finalRound = Math.max(...matches.map((match) => match.round));
  const final = matches.find(
    (match) => match.round === finalRound && match.match_number === 1,
  );

  return final?.status === 'completed' ? (final.winner_id ?? null) : null;
}

/* ==========================================================================
 * 2. Database helpers (service role — server only)
 * ========================================================================== */

/**
 * Gets the top two players of every group in a tournament, ready for the draw.
 *
 * Ranking uses the full tiebreaker order (points → goal difference → goals
 * scored → head-to-head); see `rankStandings()` in lib/groups.ts, which both
 * this function and the standings page use so they can never disagree.
 *
 * @param tournamentId The tournament's UUID.
 * @returns One entry per qualified player, group A first.
 *
 * @example
 * const winners = await getGroupWinners(tournamentId);
 * winners.map((q) => `${q.group_name}${q.position}`); // ['A1','A2','B1','B2']
 */
export async function getGroupWinners(
  tournamentId: string,
): Promise<GroupQualifier[]> {
  if (!isSupabaseConfigured() || !tournamentId) return [];

  try {
    const supabase = supabaseAdmin();

    const { data: groupRows } = await supabase
      .from('groups')
      .select('id, group_name')
      .eq('tournament_id', tournamentId)
      .order('group_name', { ascending: true });

    const groups = (groupRows ?? []) as Array<{ id: string; group_name: string }>;
    if (groups.length === 0) return [];

    const { data: standingRows } = await supabase
      .from('group_standings')
      .select('*')
      .eq('tournament_id', tournamentId);

    const { data: matchRows } = await supabase
      .from('group_matches')
      .select('*')
      .eq('tournament_id', tournamentId);

    const { data: playerRows } = await supabase
      .from('registrations')
      .select('*')
      .eq('tournament_id', tournamentId)
      .eq('payment_status', 'paid');

    const standings = (standingRows ?? []) as GroupStanding[];
    const matches = (matchRows ?? []) as GroupMatch[];
    const players = (playerRows ?? []) as Registration[];
    const playerById = new Map(players.map((player) => [player.id, player]));

    // Import here to avoid a circular import at module load time.
    const { rankStandings } = await import('./groups');

    const qualifiers: GroupQualifier[] = [];

    groups.forEach((group) => {
      const groupMatches = matches.filter(
        (match) => match.group_id === group.id,
      );

      const rows = standings
        .filter((row) => row.group_id === group.id)
        .map((row) => ({
          ...row,
          player_name: playerById.get(row.player_id)?.player_name ?? 'Unknown',
          dls_team_name: playerById.get(row.player_id)?.dls_team_name ?? '—',
        }));

      rankStandings(rows, groupMatches)
        .filter((row) => row.position <= 2)
        .forEach((row) => {
          const player = playerById.get(row.player_id);
          if (!player) return;

          qualifiers.push({
            player,
            group_name: group.group_name,
            position: row.position,
          });
        });
    });

    return qualifiers;
  } catch (error) {
    console.error('[bracket.getGroupWinners]', error);
    return [];
  }
}

/** What `checkAndResolveMatch()` decided. */
export interface KnockoutResolution {
  /** True when both players have now submitted. */
  bothSubmitted: boolean;
  /** The match's status after this check. */
  status: MatchStatus;
  /** True when the two claims agreed and the match is confirmed. */
  confirmed: boolean;
  /** True when the two claims contradicted each other. */
  disputed: boolean;
  /** The confirmed winner, or null while undecided (or for a dispute). */
  winner_id: string | null;
}

/**
 * Decides a knockout match once BOTH players have submitted.
 *
 * The rule (from the tournament rules):
 * - both submissions agree  → the match is 'completed', the winner is confirmed
 *   and is moved into the next round automatically. Winning the Grand Final
 *   marks the tournament 'completed'.
 * - the submissions conflict → the match is 'disputed' and waits for the
 *   organizer, who fixes it in the Supabase dashboard within 24 hours.
 * - only one submission    → nothing is decided yet; the match stays 'pending'
 *   and this function reports `bothSubmitted: false`.
 *
 * The first player's claim is stored in `brackets.winner_id` while the match is
 * pending, which is what the second claim is compared against. That stored claim
 * is never shown to players until the match is completed.
 *
 * @param matchId The `brackets.id` to check.
 * @param secondClaimWinnerId The winner the player who just submitted claims.
 *                            Omit it when re-checking a row by hand.
 * @returns What was decided. Never throws: a failure is logged and reported as
 *          "nothing decided" so a player's screenshot is never lost.
 *
 * @example
 * await checkAndResolveMatch(matchId, claimedWinnerId);
 */
export async function checkAndResolveMatch(
  matchId: string,
  secondClaimWinnerId?: string,
): Promise<KnockoutResolution> {
  const undecided: KnockoutResolution = {
    bothSubmitted: false,
    status: 'pending',
    confirmed: false,
    disputed: false,
    winner_id: null,
  };

  try {
    const supabase = supabaseAdmin();

    const { data: matchRow } = await supabase
      .from('brackets')
      .select('*')
      .eq('id', matchId)
      .maybeSingle();

    if (!matchRow) return undecided;

    const match = matchRow as Bracket;

    // Already decided by an earlier call (or by the organizer).
    if (match.status === 'completed' || match.status === 'disputed') {
      return {
        bothSubmitted: true,
        status: match.status,
        confirmed: match.status === 'completed',
        disputed: match.status === 'disputed',
        winner_id: match.status === 'completed' ? match.winner_id : null,
      };
    }

    // Both players must have provided their screenshot before anything is decided.
    const bothSubmitted =
      Boolean(match.player_a_screenshot) && Boolean(match.player_b_screenshot);

    if (!bothSubmitted) {
      return undecided;
    }

    // The first claim is already stored in winner_id.
    const firstClaim = match.winner_id;

    // If no second claim was supplied (e.g. the organizer re-runs the check),
    // there is nothing new to compare, so leave the match pending.
    if (!firstClaim || !secondClaimWinnerId) {
      return { ...undecided, bothSubmitted: true };
    }

    const updates: Record<string, unknown> = {};

    if (firstClaim === secondClaimWinnerId) {
      // Both players agree: confirm the result and move the winner on.
      updates.status = 'completed';
      updates.winner_id = firstClaim;

      const { error } = await supabase
        .from('brackets')
        .update(updates)
        .eq('id', match.id);

      if (error) {
        console.error('[bracket.checkAndResolveMatch] update failed', error.message);
        return { ...undecided, bothSubmitted: true };
      }

      await advanceWinner(match, firstClaim);

      return {
        bothSubmitted: true,
        status: 'completed',
        confirmed: true,
        disputed: false,
        winner_id: firstClaim,
      };
    }

    // They disagree: hand it to the organizer.
    updates.status = 'disputed';
    updates.winner_id = null;

    const { error } = await supabase
      .from('brackets')
      .update(updates)
      .eq('id', match.id);

    if (error) {
      console.error('[bracket.checkAndResolveMatch] update failed', error.message);
      return { ...undecided, bothSubmitted: true };
    }

    return {
      bothSubmitted: true,
      status: 'disputed',
      confirmed: false,
      disputed: true,
      winner_id: null,
    };
  } catch (error) {
    console.error('[bracket.checkAndResolveMatch]', error);
    return undecided;
  }
}

/**
 * Moves a confirmed winner into their next-round slot, or finishes the
 * tournament if they just won the Grand Final.
 *
 * @param match The match that was just completed.
 * @param winnerId The confirmed winner.
 * @returns Nothing. Failures are logged; the result itself is already saved.
 */
async function advanceWinner(match: Bracket, winnerId: string): Promise<void> {
  try {
    const supabase = supabaseAdmin();

    // How many rounds does this tournament have?
    const { data: rows } = await supabase
      .from('brackets')
      .select('round')
      .eq('tournament_id', match.tournament_id);

    const rounds = (rows ?? []) as Array<{ round: number }>;
    const totalRounds = rounds.length
      ? Math.max(...rounds.map((row) => row.round))
      : match.round;

    // Winning the last round ends the tournament.
    if (match.round >= totalRounds) {
      await supabase
        .from('tournaments')
        .update({ status: 'completed' })
        .eq('id', match.tournament_id);
      return;
    }

    const destination = nextRoundSlot(match);
    const column = destination.slot === 'a' ? 'player_a_id' : 'player_b_id';

    const { data: nextMatch } = await supabase
      .from('brackets')
      .select('id')
      .eq('tournament_id', match.tournament_id)
      .eq('round', destination.round)
      .eq('match_number', destination.match_number)
      .maybeSingle();

    if (nextMatch) {
      // The placeholder row from the draw already exists.
      await supabase
        .from('brackets')
        .update({ [column]: winnerId })
        .eq('id', nextMatch.id);
      return;
    }

    // Safety net: create the next match if the placeholder is missing (for
    // example if an earlier round was drawn by hand in Supabase).
    await supabase.from('brackets').insert({
      tournament_id: match.tournament_id,
      round: destination.round,
      match_number: destination.match_number,
      [column]: winnerId,
      status: 'pending',
    });
  } catch (error) {
    console.error('[bracket.advanceWinner]', error);
  }
}

/**
 * Converts a qualifier's registration into safe display fields.
 *
 * @param qualifier A qualifier (holds a full registration row).
 * @returns `{ id, player_name, dls_team_name }` — no phone numbers.
 */
export function qualifierToPublicPlayer(qualifier: GroupQualifier): PublicPlayer {
  return {
    id: qualifier.player.id,
    player_name: qualifier.player.player_name,
    dls_team_name: qualifier.player.dls_team_name,
  };
}
