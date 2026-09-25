/**
 * Server-side data access for the admin dashboard (MODULE 4).
 *
 * The loaders here run on the server with the service-role key and return the
 * organizer's view of the data — INCLUDING private contact fields (phone, MoMo,
 * Paystack reference). Every API route that serves them is protected by
 * `isAdminRequest()`, so nothing below may ever be reached by a page render.
 *
 * The heavy lifting stays in `lib/admin-rules.ts` (pure, tested): these loaders
 * fetch rows, hand them to the rules, and shape the result the dashboard pages
 * expect. Like every other loader in `lib/data.ts` they degrade gracefully when
 * Supabase is not configured, returning null instead of crashing.
 */

import type {
  AdminGroupStandings,
  AdminMatchRow,
  AdminOverview,
  AdminRegistrationRow,
  AdminTournamentSummary,
  Bracket,
  Group,
  GroupMatch,
  GroupStanding,
  Registration,
  StandingRow,
  Tournament,
} from '@/types';
import { isSupabaseConfigured, supabaseAdmin } from './supabase';
import { calculatePrizes } from './calculations';
import { knockoutMatchLabel } from './bracket';
import { rankStandings } from './groups';
import {
  adminActionAvailability,
  countMatches,
  countPayments,
} from './admin-rules';

/**
 * Every tournament, newest first, with its live player counts — the data behind
 * the dashboard's tournament picker.
 *
 * @returns The summaries, or null when Supabase is not configured or the query
 *          failed (the dashboard shows a friendly message instead).
 */
export async function getAdminTournaments(): Promise<AdminTournamentSummary[] | null> {
  if (!isSupabaseConfigured()) return null;

  try {
    const supabase = supabaseAdmin();

    const [{ data: tournamentRows }, { data: registrationRows }] = await Promise.all([
      supabase.from('tournaments').select('*').order('created_at', { ascending: false }),
      supabase.from('registrations').select('tournament_id, payment_status'),
    ]);

    const tournaments = (tournamentRows ?? []) as Tournament[];
    const registrations = (registrationRows ?? []) as Array<
      Pick<Registration, 'tournament_id' | 'payment_status'>
    >;

    return tournaments.map((tournament) => {
      const counts = countPayments(
        registrations.filter((row) => row.tournament_id === tournament.id),
      );
      return {
        tournament,
        paid_players: counts.paid,
        pending_players: counts.pending,
      };
    });
  } catch (error) {
    console.error('[admin-data.getAdminTournaments]', error);
    return null;
  }
}

/**
 * Resolves which tournament the dashboard should show: the requested one when
 * it exists, else the active (latest unfinished) one, else the latest one.
 *
 * @param requestedId An explicit tournament id from the query string.
 * @returns The tournament to display, or null when there are none at all.
 */
export async function resolveAdminTournament(
  requestedId?: string | null,
): Promise<Tournament | null> {
  if (!isSupabaseConfigured()) return null;

  if (requestedId) {
    const byId = await getTournamentRow(requestedId);
    if (byId) return byId;
    // An unknown/stale id (e.g. a deleted tournament remembered in the
    // browser) falls through to the active tournament.
  }

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
    console.error('[admin-data.resolveAdminTournament]', error);
    return null;
  }
}

/**
 * Loads one tournament row (a trimmed copy of `getTournamentById` that keeps
 * this module self-contained).
 *
 * @param tournamentId The tournament's UUID.
 * @returns The tournament, or null.
 */
async function getTournamentRow(tournamentId: string): Promise<Tournament | null> {
  try {
    const { data } = await supabaseAdmin()
      .from('tournaments')
      .select('*')
      .eq('id', tournamentId)
      .maybeSingle();
    return (data as Tournament) ?? null;
  } catch {
    return null;
  }
}

/**
 * Everything the Overview page shows for one tournament, in one response.
 *
 * @param tournamentId Explicit tournament id, or null for "the active one".
 * @returns The overview, or null when nothing can be loaded.
 */
export async function getAdminOverview(
  tournamentId?: string | null,
): Promise<AdminOverview | null> {
  if (!isSupabaseConfigured()) return null;

  const [tournaments, tournament] = await Promise.all([
    getAdminTournaments(),
    resolveAdminTournament(tournamentId),
  ]);

  if (!tournament) return null;

  try {
    const supabase = supabaseAdmin();

    const [{ data: registrationRows }, { data: groupMatchRows }, { data: bracketRows }] =
      await Promise.all([
        supabase
          .from('registrations')
          .select('*')
          .eq('tournament_id', tournament.id)
          .order('created_at', { ascending: false }),
        supabase.from('group_matches').select('*').eq('tournament_id', tournament.id),
        supabase.from('brackets').select('*').eq('tournament_id', tournament.id),
      ]);

    const registrations = (registrationRows ?? []) as Registration[];
    const groupMatches = (groupMatchRows ?? []) as GroupMatch[];
    const brackets = (bracketRows ?? []) as Bracket[];

    const payment_counts = countPayments(registrations);
    const groupCounts = countMatches(groupMatches);
    const knockoutCounts = countMatches(brackets);

    const recent: AdminRegistrationRow[] = registrations.slice(0, 8).map((row) => ({
      ...row,
      registered_at: (row.created_at ?? '').slice(0, 10),
    }));

    return {
      tournaments: tournaments ?? [],
      tournament,
      payment_counts,
      revenue_pesewas: payment_counts.paid * tournament.entry_fee,
      prizes: calculatePrizes(payment_counts.paid, tournament.entry_fee),
      group_matches: groupCounts,
      knockout_matches: knockoutCounts,
      actions: adminActionAvailability({
        tournament,
        payment_counts,
        group_matches: groupCounts,
        knockout_matches: knockoutCounts,
      }),
      recent_registrations: recent,
    };
  } catch (error) {
    console.error('[admin-data.getAdminOverview]', error);
    return null;
  }
}

/**
 * The full registration list for one tournament — the organizer's private
 * view, contact details included.
 *
 * @param tournamentId The tournament's UUID.
 * @returns The registrations, or null when they cannot be loaded.
 */
export async function getAdminRegistrations(
  tournamentId: string,
): Promise<AdminRegistrationRow[] | null> {
  if (!isSupabaseConfigured() || !tournamentId) return null;

  try {
    const { data } = await supabaseAdmin()
      .from('registrations')
      .select('*')
      .eq('tournament_id', tournamentId)
      .order('created_at', { ascending: false });

    return ((data ?? []) as Registration[]).map((row) => ({
      ...row,
      registered_at: (row.created_at ?? '').slice(0, 10),
    }));
  } catch (error) {
    console.error('[admin-data.getAdminRegistrations]', error);
    return null;
  }
}

/**
 * Every match of one tournament — group fixtures and knockout bracket rows,
 * decorated with player and group names — for the admin Matches page.
 *
 * @param tournamentId The tournament's UUID.
 * @returns Group matches followed by knockout matches, or null on failure.
 */
export async function getAdminMatches(
  tournamentId: string,
): Promise<AdminMatchRow[] | null> {
  if (!isSupabaseConfigured() || !tournamentId) return null;

  try {
    const supabase = supabaseAdmin();

    const [{ data: registrationRows }, { data: groupRows }, { data: groupMatchRows }, { data: bracketRows }] =
      await Promise.all([
        supabase.from('registrations').select('*').eq('tournament_id', tournamentId),
        supabase.from('groups').select('*').eq('tournament_id', tournamentId),
        supabase
          .from('group_matches')
          .select('*')
          .eq('tournament_id', tournamentId)
          .order('match_number', { ascending: true }),
        supabase
          .from('brackets')
          .select('*')
          .eq('tournament_id', tournamentId)
          .order('round', { ascending: true })
          .order('match_number', { ascending: true }),
      ]);

    const players = new Map(
      ((registrationRows ?? []) as Registration[]).map((row) => [row.id, row]),
    );
    const groups = new Map(
      ((groupRows ?? []) as Group[]).map((row) => [row.id, row.group_name]),
    );
    const groupMatches = (groupMatchRows ?? []) as GroupMatch[];
    const brackets = (bracketRows ?? []) as Bracket[];

    const name = (id: string | null): string => (id ? players.get(id)?.player_name ?? 'Unknown player' : 'To be decided');
    const team = (id: string | null): string | null => (id ? players.get(id)?.dls_team_name ?? null : null);

    const rows: AdminMatchRow[] = groupMatches.map((match) => ({
      id: match.id,
      kind: 'group',
      label: `Group ${groups.get(match.group_id) ?? '?'} · Match ${match.match_number}`,
      player_a_name: name(match.player_a_id),
      player_b_name: name(match.player_b_id),
      player_a_team: team(match.player_a_id),
      player_b_team: team(match.player_b_id),
      player_a_score: match.player_a_score,
      player_b_score: match.player_b_score,
      winner_id: match.winner_id,
      winner_name: match.winner_id ? name(match.winner_id) : null,
      status: match.status,
      player_a_screenshot: match.player_a_screenshot,
      player_b_screenshot: match.player_b_screenshot,
      player_a_id: match.player_a_id,
      player_b_id: match.player_b_id,
    }));

    const totalRounds = brackets.length ? Math.max(...brackets.map((row) => row.round)) : 0;

    for (const match of brackets) {
      rows.push({
        id: match.id,
        kind: 'knockout',
        label: knockoutMatchLabel(match.round, match.match_number, totalRounds),
        player_a_name: name(match.player_a_id),
        player_b_name: name(match.player_b_id),
        player_a_team: team(match.player_a_id),
        player_b_team: team(match.player_b_id),
        player_a_score: null,
        player_b_score: null,
        winner_id: match.status === 'completed' ? match.winner_id : null,
        winner_name: match.status === 'completed' && match.winner_id ? name(match.winner_id) : null,
        status: match.status,
        player_a_screenshot: match.player_a_screenshot,
        player_b_screenshot: match.player_b_screenshot,
        player_a_id: match.player_a_id,
        player_b_id: match.player_b_id,
      });
    }

    return rows;
  } catch (error) {
    console.error('[admin-data.getAdminMatches]', error);
    return null;
  }
}

/**
 * The group standings for one tournament, ranked exactly the way the public
 * groups page ranks them (points → goal difference → goals for → head-to-head)
 * — so the organizer sees the same league tables inside the dashboard without
 * leaving for the player site.
 *
 * @param tournamentId The tournament's UUID.
 * @returns One entry per group with its ranked rows, or null on failure
 *          (and an empty array before the draw has happened).
 */
export async function getAdminStandings(
  tournamentId: string,
): Promise<AdminGroupStandings[] | null> {
  if (!isSupabaseConfigured() || !tournamentId) return null;

  try {
    const supabase = supabaseAdmin();

    const [{ data: groupRows }, { data: standingRows }, { data: matchRows }, { data: playerRows }] =
      await Promise.all([
        supabase.from('groups').select('*').eq('tournament_id', tournamentId).order('group_name'),
        supabase.from('group_standings').select('*').eq('tournament_id', tournamentId),
        supabase.from('group_matches').select('*').eq('tournament_id', tournamentId),
        supabase
          .from('registrations')
          .select('id, player_name, dls_team_name')
          .eq('tournament_id', tournamentId),
      ]);

    const groups = (groupRows ?? []) as Group[];
    if (groups.length === 0) return [];

    const standings = (standingRows ?? []) as GroupStanding[];
    const matches = (matchRows ?? []) as GroupMatch[];
    const players = new Map(
      ((playerRows ?? []) as Array<{
        id: string;
        player_name: string;
        dls_team_name: string;
      }>).map((row) => [row.id, row]),
    );

    return groups.map((group) => {
      // Decorate the bare standings rows with names, then rank them.
      const decorated = standings
        .filter((row) => row.group_id === group.id)
        .map((row) => ({
          ...row,
          player_name: players.get(row.player_id)?.player_name ?? 'Unknown player',
          dls_team_name: players.get(row.player_id)?.dls_team_name ?? '',
        }));

      const rows: StandingRow[] = rankStandings(decorated, matches);

      return {
        group_id: group.id,
        group_name: group.group_name,
        rows,
      };
    });
  } catch (error) {
    console.error('[admin-data.getAdminStandings]', error);
    return null;
  }
}
