/**
 * POST /api/admin/draw-groups   (MODULE 2)
 *
 * Runs the group-stage draw. Protected by the ADMIN_SECRET — the MVP has no
 * admin dashboard UI by design, so the organizer calls this with curl/Postman:
 *
 *   curl -X POST https://your-app.vercel.app/api/admin/draw-groups \
 *     -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"tournament_id":"THE-TOURNAMENT-UUID"}'
 *
 * Steps:
 *  1. Fetch every PAID registration for the tournament.
 *  2. Shuffle them with Fisher-Yates (a provably fair draw).
 *  3. Split them into groups of 4: 8 players → A & B, 12 → A, B & C,
 *     16 → A, B, C & D.
 *  4. Create the `groups` records.
 *  5. Create the `group_members` records.
 *  6. Generate every round-robin fixture (a group of 4 = 6 matches) and save
 *     them to `group_matches`. Player A is the higher seed who generates the
 *     Friend Match code.
 *  7. Initialise `group_standings` for every player (all zeros).
 *  8. Set the tournament status to 'groups_drawn'.
 *
 * Response: { success: true, groups: GroupDraw[], fixtures_created: number }
 */

import { NextResponse } from 'next/server';
import type { GroupDraw } from '@/types';
import { handleServerError, isAdminRequest, jsonError, readJsonBody } from '@/lib/api';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase';
import { createGroups, generateGroupFixtures } from '@/lib/groups';
import { getPaidPlayers } from '@/lib/data';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/** Minimum paid players needed for a meaningful groups → knockout tournament. */
const MIN_PLAYERS = 6;

/** Maximum players this format supports (4 groups of 4). */
const MAX_PLAYERS = 16;

/**
 * Runs the draw and saves it.
 *
 * @param request The incoming request (body: `{ tournament_id }`).
 * @returns The drawn groups with their fixtures, or a friendly error.
 */
export async function POST(request: Request) {
  try {
    // --- Auth: Authorization: Bearer ADMIN_SECRET (x-admin-secret also works) ---
    if (!isAdminRequest(request)) {
      return jsonError('Not authorised. Check your admin secret.', 401);
    }

    const body = await readJsonBody<{ tournament_id?: string }>(request);
    const tournamentId = body?.tournament_id?.trim();

    if (!tournamentId) {
      return jsonError(
        'Send the tournament id in the body, e.g. {"tournament_id":"..."}.',
        400,
      );
    }

    if (!isSupabaseConfigured()) {
      return jsonError('Supabase is not configured on the server.', 503);
    }

    const supabase = supabaseAdmin();

    // --- Load the tournament ---------------------------------------------
    const { data: tournamentRow } = await supabase
      .from('tournaments')
      .select('id, title, status')
      .eq('id', tournamentId)
      .maybeSingle();

    if (!tournamentRow) {
      return jsonError('That tournament could not be found.', 404);
    }

    if (tournamentRow.status === 'groups_drawn') {
      return jsonError(
        'Groups have already been drawn for this tournament. Delete the groups, group_members, group_matches and group_standings rows in Supabase if you need to redraw.',
        409,
      );
    }

    // --- 1. Paid players only --------------------------------------------
    const players = await getPaidPlayers(tournamentId);

    if (players.length < MIN_PLAYERS) {
      return jsonError(
        `Only ${players.length} paid player(s) so far — you need at least ${MIN_PLAYERS} to draw groups.`,
        409,
      );
    }

    if (players.length > MAX_PLAYERS) {
      return jsonError(
        `This format supports up to ${MAX_PLAYERS} players (found ${players.length}).`,
        409,
      );
    }

    // --- 2 & 3. Fair draw into groups of four ----------------------------
    const drawn = createGroups(players);

    // --- 4. Save the groups ----------------------------------------------
    const { data: insertedGroups, error: groupError } = await supabase
      .from('groups')
      .insert(
        drawn.map((group) => ({
          tournament_id: tournamentId,
          group_name: group.group_name,
        })),
      )
      .select();

    if (groupError || !insertedGroups) {
      return handleServerError(
        'draw-groups',
        groupError,
        'We could not create the groups. Nothing was changed — please try again.',
      );
    }

    const groupIdByName = new Map<string, string>(
      insertedGroups.map((row) => [row.group_name as string, row.id as string]),
    );

    // --- 5. Save the group members ---------------------------------------
    const memberRows = drawn.flatMap((group) =>
      group.players.map((player) => ({
        group_id: groupIdByName.get(group.group_name) as string,
        tournament_id: tournamentId,
        player_id: player.id,
      })),
    );

    const { error: memberError } = await supabase
      .from('group_members')
      .insert(memberRows);

    if (memberError) {
      return handleServerError(
        'draw-groups',
        memberError,
        'We could not save the group members. Please delete the groups and try again.',
      );
    }

    // --- 6. Generate the round-robin fixtures ----------------------------
    // `createGroups` returns public players (no phone numbers), so the fixtures
    // are generated from the full registration rows we already loaded.
    const registrationById = new Map(
      players.map((player) => [player.id, player]),
    );

    const fixtureRows = drawn.flatMap((group) => {
      const groupId = groupIdByName.get(group.group_name) as string;
      const groupPlayers = group.players
        .map((player) => registrationById.get(player.id))
        .filter((player): player is NonNullable<typeof player> =>
          Boolean(player),
        );

      // A group of 4 produces exactly 6 fixtures.
      const fixtures = generateGroupFixtures(groupId, groupPlayers);

      return fixtures.map((fixture) => ({
        group_id: fixture.group_id,
        tournament_id: fixture.tournament_id,
        match_number: fixture.match_number,
        player_a_id: fixture.player_a_id,
        player_b_id: fixture.player_b_id,
        status: fixture.status,
      }));
    });

    const { data: insertedFixtures, error: fixtureError } = await supabase
      .from('group_matches')
      .insert(fixtureRows)
      .select();

    if (fixtureError) {
      return handleServerError(
        'draw-groups',
        fixtureError,
        'The groups were created but the fixtures failed. Delete the groups and run the draw again.',
      );
    }

    // --- 7. Zeroed league tables -----------------------------------------
    const standingRows = memberRows.map((member) => ({
      group_id: member.group_id,
      tournament_id: tournamentId,
      player_id: member.player_id,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goals_for: 0,
      goals_against: 0,
      goal_difference: 0,
      points: 0,
    }));

    const { error: standingError } = await supabase
      .from('group_standings')
      .upsert(standingRows, { onConflict: 'group_id,player_id' });

    if (standingError) {
      return handleServerError(
        'draw-groups',
        standingError,
        'The fixtures were created but the standings failed to initialise.',
      );
    }

    // --- 8. Move the tournament on ---------------------------------------
    const { error: statusError } = await supabase
      .from('tournaments')
      .update({ status: 'groups_drawn' })
      .eq('id', tournamentId);

    if (statusError) {
      return handleServerError(
        'draw-groups',
        statusError,
        'The draw is complete but the tournament status could not be updated.',
      );
    }

    // --- Response --------------------------------------------------------
    // Fixtures come back from the insert so the caller sees the real ids.
    const fixturesByGroupId = new Map<string, typeof insertedFixtures>();
    (insertedFixtures ?? []).forEach((fixture) => {
      const list = fixturesByGroupId.get(fixture.group_id as string) ?? [];
      list.push(fixture);
      fixturesByGroupId.set(fixture.group_id as string, list);
    });

    const groups: GroupDraw[] = drawn.map((group) => {
      const groupId = groupIdByName.get(group.group_name) as string;
      const rows = (fixturesByGroupId.get(groupId) ?? [])
        .slice()
        .sort(
          (a, b) => (a.match_number as number) - (b.match_number as number),
        );

      return {
        group_name: group.group_name,
        // `createGroups` already reduced players to safe display fields, so
        // phone numbers never leave the server.
        players: group.players,
        fixtures: rows.map((row) => ({
          id: row.id as string,
          group_id: row.group_id as string,
          tournament_id: row.tournament_id as string,
          match_number: row.match_number as number,
          player_a_id: row.player_a_id as string,
          player_b_id: row.player_b_id as string,
          player_a_score: (row.player_a_score as number | null) ?? null,
          player_b_score: (row.player_b_score as number | null) ?? null,
          player_a_screenshot: null,
          player_b_screenshot: null,
          winner_id: null,
          status: (row.status as 'pending') ?? 'pending',
          created_at: (row.created_at as string) ?? new Date().toISOString(),
        })),
      };
    });

    return NextResponse.json({
      success: true,
      groups,
      fixtures_created: fixtureRows.length,
    });
  } catch (error) {
    return handleServerError(
      'draw-groups',
      error,
      'The draw could not be completed. Please try again.',
    );
  }
}
