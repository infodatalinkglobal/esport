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
 * MODULE 3 will add the bracket loaders.
 *
 * ⚠️ The `paid`/player loaders below return rows that include phone numbers.
 * They are for server-side use only — use `toPublicPlayer()` (lib/groups.ts)
 * before anything is sent to a browser.
 */

import type {
  FixtureView,
  Group,
  GroupMatch,
  GroupStanding,
  GroupWithStandings,
  PublicPlayer,
  Registration,
  StandingRow,
  Tournament,
} from '@/types';
import { isSupabaseConfigured, supabaseAdmin } from './supabase';
import { groupFixturesByGroup, rankStandings } from './groups';

/**
 * Loads the tournament the landing page should advertise.
 *
 * Preference order:
 * 1. the most recently created tournament that is not finished,
 * 2. otherwise the most recently created tournament.
 *
 * @returns The tournament, or null when none exists / Supabase is not set up.
 */
export async function getActiveTournament(): Promise<Tournament | null> {
  if (!isSupabaseConfigured()) return null;

  try {
    const supabase = supabaseAdmin();

    const { data: active } = await supabase
      .from('tournaments')
      .select('*')
      .neq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (active) return active as Tournament;

    const { data: latest } = await supabase
      .from('tournaments')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return (latest as Tournament) ?? null;
  } catch (error) {
    console.error('[data.getActiveTournament]', error);
    return null;
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
 * same numbers to decide whether the tournament is full.
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
    const { data } = await supabase
      .from('registrations')
      .select('payment_status')
      .eq('tournament_id', tournamentId);

    const rows = (data ?? []) as Array<{ payment_status: string }>;

    return {
      paid: rows.filter((row) => row.payment_status === 'paid').length,
      pending: rows.filter((row) => row.payment_status === 'pending').length,
      failed: rows.filter((row) => row.payment_status === 'failed').length,
      total: rows.length,
    };
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
 * @returns The paid registrations, oldest first.
 */
export async function getPaidPlayers(
  tournamentId: string,
): Promise<Registration[]> {
  if (!isSupabaseConfigured() || !tournamentId) return [];

  try {
    const supabase = supabaseAdmin();
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
