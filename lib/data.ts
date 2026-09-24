/**
 * Server-side data access.
 *
 * Everything here runs on the server (React Server Components or API routes)
 * with the service-role key. Every function degrades gracefully: if Supabase is
 * not configured yet, or a query fails, it returns `null`/empty values so the UI
 * can show a friendly message instead of crashing.
 *
 * MODULE 1: tournaments and player counts.
 * MODULE 2: groups, standings and fixtures (plus the player-name map that
 *           decorates them).
 * MODULE 3: the knockout bracket loaders.
 *
 * ⚠️ The `paid`/player loaders below return rows that include phone numbers.
 * They are for server-side use only — use `toPublicPlayer()` (lib/groups.ts)
 * before anything is sent to a browser.
 */

import type {
  Bracket,
  BracketMatchView,
  FixtureView,
  Group,
  GroupMatch,
  GroupStanding,
  GroupWithStandings,
  ChampionEntry,
  PublicPlayer,
  PlayerFixtureView,
  PlayerTournamentView,
  Registration,
  StandingRow,
  Tournament,
} from '@/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabaseAdmin } from './supabase';
import { groupFixturesByGroup, rankStandings } from './groups';
import { knockoutMatchLabel } from './bracket';
import { isValidGhanaPhone, normalizePhone } from './format';
import { calculatePrizes } from './calculations';
import {
  playerGroupFixtureView,
  playerKnockoutFixtureView,
} from './player-view';

/**
 * Loads the tournament the landing page should advertise.
 *
 * Preference order:
 * 1. the most recently created tournament that is not finished,
 * 2. otherwise the most recently created tournament.
 *
 * @returns The tournament, or null if none can be loaded (including on error).
 */
export async function getActiveTournament(): Promise<Tournament | null> {
  return (await getActiveTournamentWithStatus()).tournament;
}

/**
 * Keeps query failures visible to the home page without changing the nullable
 * result used by other pages.
 */
export async function getActiveTournamentWithStatus(): Promise<{
  tournament: Tournament | null;
  failed: boolean;
}> {
  if (!isSupabaseConfigured()) return { tournament: null, failed: false };

  try {
    const supabase = supabaseAdmin();

    const { data: active, error: activeError } = await supabase
      .from('tournaments')
      .select('*')
      .neq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Supabase returns query errors in the response rather than throwing them.
    if (activeError) console.error('[data.getActiveTournament]', activeError);
    if (active) {
      return { tournament: active as Tournament, failed: Boolean(activeError) };
    }

    const { data: latest, error: latestError } = await supabase
      .from('tournaments')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestError) console.error('[data.getActiveTournament]', latestError);
    return {
      tournament: (latest as Tournament) ?? null,
      failed: Boolean(activeError || latestError),
    };
  } catch (error) {
    console.error('[data.getActiveTournament]', error);
    return { tournament: null, failed: true };
  }
}

/**
 * Loads a single tournament by id.
 *
 * @param tournamentId The tournament's UUID.
 * @returns The tournament, or null when it does not exist.
 */
export async function getTournamentById(
  tournamentId: string,
): Promise<Tournament | null> {
  if (!isSupabaseConfigured() || !tournamentId) return null;

  try {
    const supabase = supabaseAdmin();
    const { data } = await supabase
      .from('tournaments')
      .select('*')
      .eq('id', tournamentId)
      .maybeSingle();

    return (data as Tournament) ?? null;
  } catch (error) {
    console.error('[data.getTournamentById]', error);
    return null;
  }
}

/**
 * Counts a tournament's registrations, split by payment status.
 *
 * The landing page shows "6 / 8 registered", and the registration API uses the
 * same numbers to decide whether the tournament is full. Counts come from
 * three `head: true` queries, so no registration rows ever travel over the
 * wire — this runs on every homepage render and every live poll.
 *
 * @param tournamentId The tournament's UUID.
 * @returns `{ paid, pending, failed, total }` — all zeros on failure.
 */
export async function getRegistrationCounts(tournamentId: string): Promise<{
  paid: number;
  pending: number;
  failed: number;
  total: number;
}> {
  const empty = { paid: 0, pending: 0, failed: 0, total: 0 };
  if (!isSupabaseConfigured() || !tournamentId) return empty;

  try {
    const supabase = supabaseAdmin();

    const countBy = async (status: string): Promise<number> => {
      const { count, error } = await supabase
        .from('registrations')
        .select('id', { count: 'exact', head: true })
        .eq('tournament_id', tournamentId)
        .eq('payment_status', status);

      if (error) {
        throw error;
      }
      return count ?? 0;
    };

    // Deliberately sequential: three tiny indexed counts, and it keeps the
    // Supabase builders out of a Promise.all (its tuple inference struggles
    // with mixed query builders — see getGroupStage below).
    const paid = await countBy('paid');
    const pending = await countBy('pending');
    const failed = await countBy('failed');

    return { paid, pending, failed, total: paid + pending + failed };
  } catch (error) {
    console.error('[data.getRegistrationCounts]', error);
    return empty;
  }
}

/* ==========================================================================
 * MODULE 2 — groups and standings
 * ========================================================================== */

/**
 * Loads the paid players of a tournament.
 *
 * ⚠️ Server-side use only: the returned rows include phone and MoMo numbers.
 *
 * @param tournamentId The tournament's UUID.
 * @param client An existing service-role client (optional). The group draw
 *        passes the client it already has, so one request never opens two
 *        connections.
 * @returns The paid registrations, oldest first.
 */
export async function getPaidPlayers(
  tournamentId: string,
  client?: SupabaseClient,
): Promise<Registration[]> {
  if (!tournamentId) return [];
  if (!client && !isSupabaseConfigured()) return [];

  try {
    const supabase = client ?? supabaseAdmin();
    const { data } = await supabase
      .from('registrations')
      .select('*')
      .eq('tournament_id', tournamentId)
      .eq('payment_status', 'paid')
      .order('created_at', { ascending: true });

    return (data ?? []) as Registration[];
  } catch (error) {
    console.error('[data.getPaidPlayers]', error);
    return [];
  }
}

/**
 * Builds a map of `registration.id` → safe player details for a tournament.
 *
 * Used to put names on fixtures and standings rows. Only display fields are
 * loaded, so this map is safe to pass down to components.
 *
 * @param tournamentId The tournament's UUID.
 * @returns A lookup keyed by player id.
 */
export async function getPlayerMap(
  tournamentId: string,
): Promise<Record<string, PublicPlayer>> {
  if (!isSupabaseConfigured() || !tournamentId) return {};

  try {
    const supabase = supabaseAdmin();
    const { data } = await supabase
      .from('registrations')
      .select('id, player_name, dls_team_name')
      .eq('tournament_id', tournamentId);

    const map: Record<string, PublicPlayer> = {};
    (data ?? []).forEach((row) => {
      map[row.id as string] = {
        id: row.id as string,
        player_name: row.player_name as string,
        dls_team_name: row.dls_team_name as string,
      };
    });

    return map;
  } catch (error) {
    console.error('[data.getPlayerMap]', error);
    return {};
  }
}

/**
 * Loads every group fixture of a tournament.
 *
 * @param tournamentId The tournament's UUID.
 * @returns Fixtures ordered by group then match number (unsorted groups come out
 *          in insertion order, which the caller normalises).
 */
export async function getGroupMatches(
  tournamentId: string,
): Promise<GroupMatch[]> {
  if (!isSupabaseConfigured() || !tournamentId) return [];

  try {
    const supabase = supabaseAdmin();
    const { data } = await supabase
      .from('group_matches')
      .select('*')
      .eq('tournament_id', tournamentId)
      .order('match_number', { ascending: true });

    return (data ?? []) as GroupMatch[];
  } catch (error) {
    console.error('[data.getGroupMatches]', error);
    return [];
  }
}

/**
 * Loads the complete group stage of a tournament: the groups, their sorted
 * league tables and every fixture with player names resolved.
 *
 * @param tournamentId The tournament's UUID.
 * @returns Groups with standings, all fixtures, fixtures grouped by group id,
 *          and a `hasGroups` flag the page uses to decide what to show.
 */
export async function getGroupStage(tournamentId: string): Promise<{
  groups: GroupWithStandings[];
  fixtures: FixtureView[];
  fixturesByGroup: Record<string, FixtureView[]>;
  hasGroups: boolean;
}> {
  const empty = {
    groups: [] as GroupWithStandings[],
    fixtures: [] as FixtureView[],
    fixturesByGroup: {} as Record<string, FixtureView[]>,
    hasGroups: false,
  };

  if (!isSupabaseConfigured() || !tournamentId) return empty;

  try {
    const supabase = supabaseAdmin();

    // Note: these are deliberately awaited one after another. Mixing Supabase
    // query builders and plain promises inside a single Promise.all confuses
    // TypeScript's tuple inference, and four small queries cost nothing here.
    const { data: groupRows } = await supabase
      .from('groups')
      .select('*')
      .eq('tournament_id', tournamentId)
      .order('group_name', { ascending: true });

    const { data: standingRows } = await supabase
      .from('group_standings')
      .select('*')
      .eq('tournament_id', tournamentId);

    const matches = await getGroupMatches(tournamentId);
    const players = await getPlayerMap(tournamentId);

    const groups = (groupRows ?? []) as Group[];
    if (groups.length === 0) return empty;

    const standings = (standingRows ?? []) as GroupStanding[];

    // --- League tables ----------------------------------------------------
    const groupsWithStandings: GroupWithStandings[] = groups.map((group) => {
      const groupMatches = matches.filter(
        (match) => match.group_id === group.id,
      );

      const rows = standings
        .filter((row) => row.group_id === group.id)
        .map((row) => ({
          ...row,
          player_name: players[row.player_id]?.player_name ?? 'Unknown player',
          dls_team_name: players[row.player_id]?.dls_team_name ?? '—',
        }));

      // Sorted with the full tiebreaker order (points → GD → GF → H2H).
      const ranked: StandingRow[] = rankStandings(rows, groupMatches);

      return { group, standings: ranked };
    });

    // --- Fixtures ---------------------------------------------------------
    const fixtures: FixtureView[] = matches.map((match) => {
      const groupName =
        groups.find((group) => group.id === match.group_id)?.group_name ?? '?';

      return {
        ...match,
        group_name: groupName,
        player_a_name:
          players[match.player_a_id]?.player_name ?? 'Unknown player',
        player_a_team: players[match.player_a_id]?.dls_team_name ?? '—',
        player_b_name:
          players[match.player_b_id]?.player_name ?? 'Unknown player',
        player_b_team: players[match.player_b_id]?.dls_team_name ?? '—',
        winner_name: match.winner_id
          ? (players[match.winner_id]?.player_name ?? null)
          : null,
      };
    });

    // Sort by group letter, then match number.
    fixtures.sort((a, b) => {
      if (a.group_name !== b.group_name) {
        return a.group_name.localeCompare(b.group_name);
      }
      return a.match_number - b.match_number;
    });

    const byGroup: Record<string, FixtureView[]> = {};
    Object.entries(groupFixturesByGroup(fixtures)).forEach(
      ([groupId, list]) => {
        byGroup[groupId] = list as FixtureView[];
      },
    );

    return {
      groups: groupsWithStandings,
      fixtures,
      fixturesByGroup: byGroup,
      hasGroups: groups.length > 0,
    };
  } catch (error) {
    console.error('[data.getGroupStage]', error);
    return empty;
  }
}

/* ==========================================================================
 * MODULE 3 — knockout bracket
 * ========================================================================== */

/**
 * Loads every knockout match of a tournament (raw rows).
 *
 * @param tournamentId The tournament's UUID.
 * @returns Matches ordered by round, then match number.
 */
export async function getBracketMatches(
  tournamentId: string,
): Promise<Bracket[]> {
  if (!isSupabaseConfigured() || !tournamentId) return [];

  try {
    const supabase = supabaseAdmin();
    const { data } = await supabase
      .from('brackets')
      .select('*')
      .eq('tournament_id', tournamentId)
      .order('round', { ascending: true })
      .order('match_number', { ascending: true });

    return (data ?? []) as Bracket[];
  } catch (error) {
    console.error('[data.getBracketMatches]', error);
    return [];
  }
}

/**
 * Loads the knockout bracket with player names resolved and round labels
 * attached, ready for the bracket page.
 *
 * A provisional winner is deliberately hidden: while a match is 'pending' the
 * `winner_id` column holds the first player's claim, and showing that to the
 * opponent would be unfair, so `winner_name` is only filled in for completed
 * matches.
 *
 * @param tournamentId The tournament's UUID.
 * @returns The bracket, ordered by round then match number.
 */
export async function getBracketView(
  tournamentId: string,
  matches?: Bracket[],
): Promise<BracketMatchView[]> {
  if (!isSupabaseConfigured() || !tournamentId) return [];

  try {
    const rows = matches ?? (await getBracketMatches(tournamentId));
    if (rows.length === 0) return [];

    const players = await getPlayerMap(tournamentId);
    const totalRounds = Math.max(...rows.map((row) => row.round));

    return rows.map((match) => ({
      ...match,
      round_label: knockoutMatchLabel(
        match.round,
        match.match_number,
        totalRounds,
      ),
      player_a_name: match.player_a_id
        ? (players[match.player_a_id]?.player_name ?? 'Unknown player')
        : null,
      player_a_team: match.player_a_id
        ? (players[match.player_a_id]?.dls_team_name ?? null)
        : null,
      player_b_name: match.player_b_id
        ? (players[match.player_b_id]?.player_name ?? 'Unknown player')
        : null,
      player_b_team: match.player_b_id
        ? (players[match.player_b_id]?.dls_team_name ?? null)
        : null,
      winner_name:
        match.status === 'completed' && match.winner_id
          ? (players[match.winner_id]?.player_name ?? null)
          : null,
    }));
  } catch (error) {
    console.error('[data.getBracketView]', error);
    return [];
  }
}

/* ==========================================================================
 * PLAYER DASHBOARD + CHAMPIONS HALL
 * ========================================================================== */

/**
 * Loads everything one player (found by WhatsApp number) can see about
 * themselves: their registration, group position, fixtures and knockout
 * matches — each rendered from their own perspective.
 *
 * Privacy: the player's own phone number identifies them, but no phone number
 * (theirs or anyone else's) is returned — opponents appear as names only, and
 * matches are arranged through the WhatsApp group per the published rules.
 *
 * @param rawPhone The WhatsApp number the player typed (any Ghanaian format).
 * @param tournamentLimit How many most-recent registrations to show (default 3).
 * @returns One {@link PlayerTournamentView} per registration, newest first;
 *          an empty array when the number is invalid or nothing is found.
 */
export async function getPlayerDashboard(
  rawPhone: string,
  tournamentLimit = 3,
): Promise<PlayerTournamentView[]> {
  const phone = normalizePhone(rawPhone ?? '');
  if (!isValidGhanaPhone(phone) || !isSupabaseConfigured()) return [];

  try {
    const supabase = supabaseAdmin();

    const { data: registrationRows } = await supabase
      .from('registrations')
      .select(
        'id, tournament_id, player_name, dls_team_name, payment_status, created_at',
      )
      .eq('phone_number', phone)
      .order('created_at', { ascending: false })
      .limit(tournamentLimit);

    const registrations = (registrationRows ?? []) as Array<
      Pick<
        Registration,
        | 'id'
        | 'tournament_id'
        | 'player_name'
        | 'dls_team_name'
        | 'payment_status'
        | 'created_at'
      >
    >;

    if (registrations.length === 0) return [];

    const views: PlayerTournamentView[] = [];

    for (const registration of registrations) {
      const tournament = await getTournamentById(registration.tournament_id);
      if (!tournament) continue;

      const players = await getPlayerMap(tournament.id);
      const teams: Record<string, string> = {};
      Object.entries(players).forEach(([id, player]) => {
        teams[id] = player.dls_team_name;
      });
      const names: Record<string, string> = {};
      Object.entries(players).forEach(([id, player]) => {
        names[id] = player.player_name;
      });

      // --- Which group is this player in? --------------------------------
      const { data: membership } = await supabase
        .from('group_members')
        .select('group_id')
        .eq('player_id', registration.id)
        .maybeSingle();

      let groupName: string | null = null;
      let position: number | null = null;

      if (membership?.group_id) {
        const groupId = membership.group_id as string;

        const { data: groupRow } = await supabase
          .from('groups')
          .select('id, group_name')
          .eq('id', groupId)
          .maybeSingle();

        groupName = (groupRow?.group_name as string) ?? null;

        if (groupRow) {
          // Rank the whole group so the player's position uses the same
          // tiebreakers as the public standings page.
          const [{ data: standingRows }, { data: matchRows }] =
            await Promise.all([
              supabase
                .from('group_standings')
                .select('*')
                .eq('group_id', groupId),
              supabase.from('group_matches').select('*').eq('group_id', groupId),
            ]);

          const rows = ((standingRows ?? []) as GroupStanding[]).map((row) => ({
            ...row,
            player_name: players[row.player_id]?.player_name ?? 'Unknown player',
            dls_team_name: players[row.player_id]?.dls_team_name ?? '—',
          }));

          const mine = rows.find((row) => row.player_id === registration.id);
          if (mine) {
            const ranked = rankStandings(
              rows,
              (matchRows ?? []) as GroupMatch[],
            );
            position = ranked.find((row) => row.player_id === registration.id)
              ?.position ?? null;
          }
        }
      }

      // --- This player's group fixtures ----------------------------------
      const { data: myGroupMatchRows } = await supabase
        .from('group_matches')
        .select('*')
        .eq('tournament_id', tournament.id)
        .or(
          `player_a_id.eq.${registration.id},player_b_id.eq.${registration.id}`,
        )
        .order('match_number', { ascending: true });

      const groupFixtures = ((myGroupMatchRows ?? []) as GroupMatch[])
        .map((match) =>
          playerGroupFixtureView(match, registration.id, names, teams),
        )
        .filter((view): view is PlayerFixtureView => view !== null);

      // --- This player's knockout matches --------------------------------
      const { data: myBracketRows } = await supabase
        .from('brackets')
        .select('*')
        .eq('tournament_id', tournament.id)
        .or(
          `player_a_id.eq.${registration.id},player_b_id.eq.${registration.id}`,
        )
        .order('round', { ascending: true })
        .order('match_number', { ascending: true });

      const bracketRows = (myBracketRows ?? []) as Bracket[];
      const totalRounds = bracketRows.length
        ? Math.max(...bracketRows.map((row) => row.round))
        : 1;

      const knockoutMatches = bracketRows
        .map((match) =>
          playerKnockoutFixtureView(
            match,
            registration.id,
            match.player_a_id === registration.id
              ? (players[match.player_b_id ?? '']?.player_name ?? null)
              : (players[match.player_a_id ?? '']?.player_name ?? null),
            match.player_a_id === registration.id
              ? (teams[match.player_b_id ?? ''] ?? null)
              : (teams[match.player_a_id ?? ''] ?? null),
            knockoutMatchLabel(
              match.round,
              match.match_number,
              totalRounds,
            ),
          ),
        )
        .filter((view): view is PlayerFixtureView => view !== null);

      views.push({
        tournament,
        player_name: registration.player_name,
        dls_team_name: registration.dls_team_name,
        payment_status: registration.payment_status,
        group_name: groupName,
        group_position: position,
        group_fixtures: groupFixtures,
        knockout_matches: knockoutMatches,
      });
    }

    return views;
  } catch (error) {
    console.error('[data.getPlayerDashboard]', error);
    return [];
  }
}

/**
 * Loads the completed tournaments for the Champions Hall: champion and
 * runner-up names from each Grand Final, plus the prizes that were paid.
 *
 * @param limit How many tournaments to show (default 10, newest first).
 * @returns Champion entries; tournaments without a decided final are skipped,
 *          and a failure degrades to an empty list.
 */
export async function getChampionsHall(limit = 10): Promise<ChampionEntry[]> {
  if (!isSupabaseConfigured()) return [];

  try {
    const supabase = supabaseAdmin();

    const { data: tournamentRows } = await supabase
      .from('tournaments')
      .select('*')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(limit);

    const tournaments = (tournamentRows ?? []) as Tournament[];
    if (tournaments.length === 0) return [];

    const entries: ChampionEntry[] = [];

    for (const tournament of tournaments) {
      const { data: bracketRows } = await supabase
        .from('brackets')
        .select('*')
        .eq('tournament_id', tournament.id);

      const brackets = (bracketRows ?? []) as Bracket[];
      if (brackets.length === 0) continue;

      const finalRound = Math.max(...brackets.map((row) => row.round));
      const finalMatch = brackets.find(
        (row) => row.round === finalRound && row.match_number === 1,
      );

      if (!finalMatch || finalMatch.status !== 'completed' || !finalMatch.winner_id) {
        continue;
      }

      const winnerId = finalMatch.winner_id;
      const runnerUpId =
        finalMatch.player_a_id === winnerId
          ? finalMatch.player_b_id
          : finalMatch.player_a_id;

      if (!runnerUpId) continue;

      const players = await getPlayerMap(tournament.id);
      const champion = players[winnerId];
      const runnerUp = players[runnerUpId];
      if (!champion || !runnerUp) continue;

      const prizes = calculatePrizes(tournament.max_players, tournament.entry_fee);

      entries.push({
        tournament,
        champion_name: champion.player_name,
        champion_team: champion.dls_team_name,
        runner_up_name: runnerUp.player_name,
        runner_up_team: runnerUp.dls_team_name,
        champion_prize: prizes.winnerPrize,
        runner_up_prize: prizes.runnerUpPrize,
      });
    }

    return entries;
  } catch (error) {
    console.error('[data.getChampionsHall]', error);
    return [];
  }
}
