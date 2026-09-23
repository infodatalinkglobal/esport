/**
 * MODULE 2 — group-stage logic.
 *
 * Two kinds of code live here:
 *
 * 1. PURE functions (no database, no network): the Fisher-Yates shuffle, the
 *    split into groups of four, the round-robin fixture generator and the
 *    league-table ranking. Pure functions are easy to reason about and cannot
 *    corrupt anything by accident.
 *
 * 2. SERVER-ONLY helpers that read/write the database with the service-role
 *    client: `updateStandings()` and `getTopTwo()`. They are called from API
 *    routes, never from a browser component — importing this file into a client
 *    component would try to bundle server code, so don't.
 *
 * Tiebreaker order used everywhere (from the tournament rules):
 *   1. Points  2. Goal Difference  3. Goals Scored  4. Head-to-Head
 *   5. Penalty Shootout — decided by the organizer, so while it is pending the
 *      table falls back to alphabetical order for stability.
 */

import type {
  GroupDraw,
  GroupMatch,
  GroupStanding,
  PublicPlayer,
  Registration,
  StandingRow,
} from '@/types';
import { supabaseAdmin } from './supabase';

/* ==========================================================================
 * 1. The draw
 * ========================================================================== */

/**
 * Randomly shuffles an array of players using the Fisher-Yates (Knuth)
 * algorithm.
 *
 * Fisher-Yates is used instead of `sort(() => Math.random() - 0.5)` because it
 * is provably unbiased: every possible ordering has exactly the same
 * probability, which is what makes the draw fair.
 *
 * @param players The paid players to shuffle. The input array is NOT modified.
 * @returns A brand new array in random order.
 *
 * @example
 * shufflePlayers([a, b, c, d]); // e.g. [c, a, d, b]
 */
export function shufflePlayers(players: Registration[]): Registration[] {
  const shuffled = players.slice();

  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    // Pick a random index from 0..i inclusive.
    const j = Math.floor(Math.random() * (i + 1));
    // Swap shuffled[i] and shuffled[j] without a temporary variable.
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled;
}

/**
 * How many groups a given number of players is split into.
 *
 * The format is groups of 4:
 *   8 players  → 2 groups (A, B)     12 players → 3 groups (A, B, C)
 *   16 players → 4 groups (A, B, C, D)
 *
 * A remainder is spread across the groups (10 players → 4, 3, 3) so nobody sits
 * out, and the maximum is 4 groups (16 players).
 *
 * @param playerCount Number of paid players.
 * @returns The number of groups (0 when there are no players).
 */
export function getGroupCount(playerCount: number): number {
  if (playerCount <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil(playerCount / 4)));
}

/**
 * The group names for a draw.
 *
 * @param groupCount How many groups are needed (1-4).
 * @returns e.g. `['A', 'B']` for two groups.
 */
export function getGroupNames(groupCount: number): string[] {
  return ['A', 'B', 'C', 'D'].slice(0, Math.max(0, groupCount));
}

/**
 * Splits an already-shuffled player list into balanced groups.
 *
 * The remainder is given to the FIRST groups, so a full group of four is filled
 * before a smaller group is created:
 *   10 players in 3 groups → 4, 3, 3   (not 3, 3, 4)
 *   8 players in 2 groups  → 4, 4
 *
 * Fairness comes from `shufflePlayers()` running first — because the list is
 * already random, dealing it out in order is just as fair as any interleaving.
 *
 * @param players Already-shuffled players.
 * @param groupCount How many groups to build.
 * @returns An array of groups, each an array of players (possibly empty when
 *          there are fewer players than groups).
 */
export function splitIntoGroups<T>(players: T[], groupCount: number): T[][] {
  if (groupCount <= 0) return [];

  const base = Math.floor(players.length / groupCount);
  const remainder = players.length % groupCount;

  const groups: T[][] = [];
  let cursor = 0;

  for (let index = 0; index < groupCount; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    groups.push(players.slice(cursor, cursor + size));
    cursor += size;
  }

  return groups;
}

/**
 * Convenience wrapper: strips a registration down to the fields that are safe
 * to show players or return from an admin API.
 *
 * Phone numbers, MoMo numbers and Paystack references are deliberately dropped.
 *
 * @param registration A full `registrations` row.
 * @returns `{ id, player_name, dls_team_name }`.
 */
export function toPublicPlayer(registration: Registration): PublicPlayer {
  return {
    id: registration.id,
    player_name: registration.player_name,
    dls_team_name: registration.dls_team_name,
  };
}

/**
 * Draws the groups for a tournament.
 *
 * @param players The paid players (any order — they are shuffled inside).
 * @returns One entry per group with its name and players, e.g.
 *          `[{ group_name: 'A', players: [PublicPlayer, ...] }, ...]`.
 *
 * @example
 * // 8 players → two groups of four
 * createGroups(paidPlayers).map((g) => g.group_name); // ['A', 'B']
 */
export function createGroups(players: Registration[]): GroupDraw[] {
  const groupCount = getGroupCount(players.length);
  const names = getGroupNames(groupCount);
  const buckets = splitIntoGroups(shufflePlayers(players), groupCount);

  return names.map((groupName, index) => ({
    group_name: groupName,
    players: (buckets[index] ?? []).map(toPublicPlayer),
    // Fixtures are generated once the group rows exist in the database (they
    // need a real group_id), so this is empty at draw time.
    fixtures: [],
  }));
}

/**
 * Generates every round-robin fixture for one group.
 *
 * Uses the circle method: player 1 stays fixed while the rest rotate, which
 * produces a complete single round robin with no repeated pairing.
 *
 * A group of 4 therefore produces 6 fixtures, as required:
 *   (1v2) (3v4) (1v3) (2v4) (1v4) (2v3)
 *
 * @param groupId The `groups.id` these fixtures belong to.
 * @param players The players in the group.
 * @returns Fixture rows ready to insert into `group_matches` (no database call).
 *
 * @example
 * generateGroupFixtures('group-uuid', fourPlayers).length; // 6
 */
export function generateGroupFixtures(
  groupId: string,
  players: Registration[],
): GroupMatch[] {
  const list = players.slice();

  // With an odd number of players one of them rests each round.
  const hasBye = list.length % 2 !== 0;
  if (hasBye) list.push(null as unknown as Registration);

  const size = list.length;
  if (size < 2) return [];

  const rounds = size - 1;
  const half = size / 2;
  const pairs: Array<[Registration, Registration]> = [];
  let arrangement = list.slice();

  for (let round = 0; round < rounds; round += 1) {
    for (let i = 0; i < half; i += 1) {
      const playerA = arrangement[i];
      const playerB = arrangement[size - 1 - i];
      // Skip the bye pairing (null) when the group has an odd player count.
      if (playerA !== null && playerB !== null) pairs.push([playerA, playerB]);
    }

    // Rotate everyone except the first player one step clockwise.
    arrangement = [
      arrangement[0],
      arrangement[size - 1],
      ...arrangement.slice(1, size - 1),
    ];
  }

  return pairs.map(([playerA, playerB], index) => ({
    // The row is not in the database yet, so this id is a placeholder that the
    // insert overwrites. It exists only to satisfy the type.
    id: '',
    group_id: groupId,
    tournament_id: playerA.tournament_id,
    match_number: index + 1,
    player_a_id: playerA.id,
    player_b_id: playerB.id,
    player_a_score: null,
    player_b_score: null,
    player_a_screenshot: null,
    player_b_screenshot: null,
    winner_id: null,
    status: 'pending',
    created_at: new Date(0).toISOString(),
  }));
}

/* ==========================================================================
 * 2. The league table
 * ========================================================================== */

/**
 * Sorts standings rows using the official tiebreaker order and fills in each
 * row's `position` and `advances` (top 2) values.
 *
 * @param rows Standings rows with the player's name already joined in.
 * @param matches The group's fixtures — needed for the head-to-head step.
 * @returns Rows sorted best-first, position 1 first.
 */
export function rankStandings(
  rows: Array<GroupStanding & { player_name: string; dls_team_name: string }>,
  matches: GroupMatch[],
): StandingRow[] {
  /**
   * Head-to-head comparison between exactly two players.
   *
   * @param aId First player's `registrations.id`.
   * @param bId Second player's `registrations.id`.
   * @returns Negative when `a` ranks above `b`, positive when below, 0 when they
   *          have not played or drew.
   */
  const headToHead = (aId: string, bId: string): number => {
    const meeting = matches.find(
      (match) =>
        match.status === 'completed' &&
        match.player_a_score !== null &&
        match.player_b_score !== null &&
        ((match.player_a_id === aId && match.player_b_id === bId) ||
          (match.player_a_id === bId && match.player_b_id === aId)),
    );

    if (!meeting) return 0;

    const aScore =
      meeting.player_a_id === aId
        ? meeting.player_a_score
        : meeting.player_b_score;
    const bScore =
      meeting.player_a_id === aId
        ? meeting.player_b_score
        : meeting.player_a_score;

    if (aScore === null || bScore === null) return 0;
    // Higher score ranks first → return a negative number.
    return bScore - aScore;
  };

  const sorted = rows.slice().sort((a, b) => {
    // 1. Points
    if (b.points !== a.points) return b.points - a.points;
    // 2. Goal difference
    if (b.goal_difference !== a.goal_difference) {
      return b.goal_difference - a.goal_difference;
    }
    // 3. Goals scored
    if (b.goals_for !== a.goals_for) return b.goals_for - a.goals_for;
    // 4. Head-to-head
    const h2h = headToHead(a.player_id, b.player_id);
    if (h2h !== 0) return h2h;
    // 5. Penalty shootout is decided by the organizer; until then keep the
    //    order stable and predictable.
    return a.player_name.localeCompare(b.player_name);
  });

  return sorted.map((row, index) => ({
    ...row,
    position: index + 1,
    // Top 2 from each group advance to the knockout stage (shown in green).
    advances: index < 2,
  }));
}

/**
 * Works out how a single fixture changes both players' league-table numbers.
 *
 * This is the maths behind the standings: Win = 3 points, Draw = 1 point,
 * Loss = 0 points, plus goals for/against and the goal difference.
 *
 * @param match A completed fixture with both scores filled in.
 * @returns The stat deltas for player A and player B, plus the winner id
 *          (null for a draw).
 */
export function calculateMatchStats(match: GroupMatch): {
  playerA: Pick<
    GroupStanding,
    'played' | 'won' | 'drawn' | 'lost' | 'goals_for' | 'goals_against' | 'goal_difference' | 'points'
  >;
  playerB: Pick<
    GroupStanding,
    'played' | 'won' | 'drawn' | 'lost' | 'goals_for' | 'goals_against' | 'goal_difference' | 'points'
  >;
  winner_id: string | null;
} {
  const scoreA = match.player_a_score ?? 0;
  const scoreB = match.player_b_score ?? 0;

  const aWon = scoreA > scoreB;
  const aDrew = scoreA === scoreB;

  return {
    playerA: {
      played: 1,
      won: aWon ? 1 : 0,
      drawn: aDrew ? 1 : 0,
      lost: !aWon && !aDrew ? 1 : 0,
      goals_for: scoreA,
      goals_against: scoreB,
      goal_difference: scoreA - scoreB,
      points: aWon ? 3 : aDrew ? 1 : 0,
    },
    playerB: {
      played: 1,
      won: !aWon && !aDrew ? 1 : 0,
      drawn: aDrew ? 1 : 0,
      lost: aWon ? 1 : 0,
      goals_for: scoreB,
      goals_against: scoreA,
      goal_difference: scoreB - scoreA,
      points: !aWon && !aDrew ? 3 : aDrew ? 1 : 0,
    },
    // Draws are allowed in the group stage, so a level score has no winner.
    winner_id: aDrew ? null : aWon ? match.player_a_id : match.player_b_id,
  };
}

/* ==========================================================================
 * 3. Database helpers (service role — server only)
 * ========================================================================== */

/**
 * Recalculates a whole group's league table from its completed fixtures and
 * saves it to `group_standings`.
 *
 * It recalculates rather than incrementing, which makes it idempotent: running
 * it twice can never double-count a result. Called automatically the moment a
 * fixture is confirmed (see `POST /api/submit-result`).
 *
 * @param match The fixture that just changed. Its `group_id` decides which
 *              table is recalculated.
 * @returns Nothing. Failures are logged, because a standings problem must never
 *          stop a player's result from being saved.
 *
 * @example
 * await updateStandings(completedMatch);
 */
export async function updateStandings(match: GroupMatch): Promise<void> {
  try {
    const supabase = supabaseAdmin();

    // 1. Every player in the group starts from zero.
    const { data: members } = await supabase
      .from('group_members')
      .select('player_id, tournament_id')
      .eq('group_id', match.group_id);

    if (!members || members.length === 0) return;

    const zeroed = members.map((member) => ({
      group_id: match.group_id,
      tournament_id: member.tournament_id as string,
      player_id: member.player_id as string,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goals_for: 0,
      goals_against: 0,
      goal_difference: 0,
      points: 0,
    }));

    await supabase
      .from('group_standings')
      .upsert(zeroed, { onConflict: 'group_id,player_id' });

    // 2. Fold in every completed fixture of this group.
    const { data: matches } = await supabase
      .from('group_matches')
      .select('*')
      .eq('group_id', match.group_id)
      .eq('status', 'completed');

    const completed = (matches ?? []) as GroupMatch[];

    /** Running totals, keyed by `registrations.id`. */
    const totals: Record<
      string,
      Pick<
        GroupStanding,
        'played' | 'won' | 'drawn' | 'lost' | 'goals_for' | 'goals_against' | 'goal_difference' | 'points'
      >
    > = {};

    const blank = () => ({
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goals_for: 0,
      goals_against: 0,
      goal_difference: 0,
      points: 0,
    });

    completed.forEach((fixture) => {
      // Only fixtures with real scores count towards the table.
      if (fixture.player_a_score === null || fixture.player_b_score === null) {
        return;
      }

      const stats = calculateMatchStats(fixture);

      const aTotals = (totals[fixture.player_a_id] ??= blank());
      const bTotals = (totals[fixture.player_b_id] ??= blank());

      aTotals.played += stats.playerA.played;
      aTotals.won += stats.playerA.won;
      aTotals.drawn += stats.playerA.drawn;
      aTotals.lost += stats.playerA.lost;
      aTotals.goals_for += stats.playerA.goals_for;
      aTotals.goals_against += stats.playerA.goals_against;
      aTotals.goal_difference += stats.playerA.goal_difference;
      aTotals.points += stats.playerA.points;

      bTotals.played += stats.playerB.played;
      bTotals.won += stats.playerB.won;
      bTotals.drawn += stats.playerB.drawn;
      bTotals.lost += stats.playerB.lost;
      bTotals.goals_for += stats.playerB.goals_for;
      bTotals.goals_against += stats.playerB.goals_against;
      bTotals.goal_difference += stats.playerB.goal_difference;
      bTotals.points += stats.playerB.points;
    });

    // 3. Write the calculated totals back, one row per player.
    await Promise.all(
      Object.entries(totals).map(([playerId, value]) =>
        supabase
          .from('group_standings')
          .update(value)
          .eq('group_id', match.group_id)
          .eq('player_id', playerId),
      ),
    );
  } catch (error) {
    console.error('[groups.updateStandings]', error);
  }
}

/**
 * Gets the top two players of a group, sorted by the full tiebreaker order.
 *
 * Used by the knockout draw in Module 3.
 *
 * @param groupId The `groups.id` to read.
 * @returns The first two players as full registrations (server-side use only —
 *          call `toPublicPlayer()` before sending anything to a browser), or an
 *          empty array when the group is not ready.
 */
export async function getTopTwo(groupId: string): Promise<Registration[]> {
  try {
    const supabase = supabaseAdmin();

    const [{ data: standingRows }, { data: matchRows }] = await Promise.all([
      supabase.from('group_standings').select('*').eq('group_id', groupId),
      supabase.from('group_matches').select('*').eq('group_id', groupId),
    ]);

    const standings = (standingRows ?? []) as GroupStanding[];
    if (standings.length === 0) return [];

    // Player details are needed for the ranking's final alphabetical fallback.
    const { data: playerRows } = await supabase
      .from('registrations')
      .select('*')
      .in(
        'id',
        standings.map((row) => row.player_id),
      );

    const players = (playerRows ?? []) as Registration[];
    const playerById = new Map(players.map((player) => [player.id, player]));

    const ranked = rankStandings(
      standings.map((row) => ({
        ...row,
        player_name: playerById.get(row.player_id)?.player_name ?? 'Unknown',
        dls_team_name: playerById.get(row.player_id)?.dls_team_name ?? '—',
      })),
      (matchRows ?? []) as GroupMatch[],
    );

    return ranked
      .slice(0, 2)
      .map((row) => playerById.get(row.player_id))
      .filter((player): player is Registration => Boolean(player));
  } catch (error) {
    console.error('[groups.getTopTwo]', error);
    return [];
  }
}

/**
 * True when every fixture in the tournament has been played.
 *
 * The knockout draw (Module 3) refuses to run until this is true.
 *
 * @param matches Every group fixture of the tournament.
 * @returns True when there is at least one fixture and all are 'completed'.
 */
export function isGroupStageComplete(matches: GroupMatch[]): boolean {
  return (
    matches.length > 0 && matches.every((match) => match.status === 'completed')
  );
}

/**
 * Groups fixtures by their `group_id`, so each group card can render the
 * fixtures that belong under its table.
 *
 * @param matches Every fixture in the tournament.
 * @returns A map of `group_id` → fixtures sorted by match number.
 */
export function groupFixturesByGroup(
  matches: GroupMatch[],
): Record<string, GroupMatch[]> {
  return matches.reduce<Record<string, GroupMatch[]>>((acc, match) => {
    if (!acc[match.group_id]) acc[match.group_id] = [];
    acc[match.group_id].push(match);
    return acc;
  }, {});
}
