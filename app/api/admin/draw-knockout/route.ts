/**
 * POST /api/admin/draw-knockout   (MODULE 3)
 *
 * Builds the knockout bracket from the group-stage results. Protected by the
 * ADMIN_SECRET — the MVP has no admin dashboard UI by design, so the organizer
 * calls this with curl/Postman:
 *
 *   curl -X POST https://your-app.vercel.app/api/admin/draw-knockout \
 *     -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"tournament_id":"THE-TOURNAMENT-UUID"}'
 *
 * Steps:
 *  1. Refuses to run until EVERY group fixture is 'completed'.
 *  2. Ranks each group with the full tiebreaker order (points → goal difference
 *     → goals scored → head-to-head) and takes the top 2.
 *  3. Creates the matchups: Semifinal 1 = Group A 1st v Group B 2nd,
 *     Semifinal 2 = Group B 1st v Group A 2nd, plus the Grand Final as a
 *     placeholder (the winners move in automatically as each match is confirmed).
 *  4. Saves them to `brackets` and sets the tournament status to 'bracket_drawn'.
 *
 * Re-running is allowed while no knockout match has been completed yet, so a
 * mistake can be corrected before any match is played.
 *
 * Response: { success: true, matchups: BracketMatchView[] }
 */

import { NextResponse } from 'next/server';
import { handleServerError, isAdminRequest, jsonError, readJsonBody } from '@/lib/api';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase';
import { createKnockoutBracket, getGroupWinners } from '@/lib/bracket';
import { isGroupStageComplete } from '@/lib/groups';
import { getBracketView, getGroupMatches } from '@/lib/data';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Runs the knockout draw and saves it.
 *
 * @param request The incoming request (body: `{ tournament_id }`).
 * @returns The created matchups, or a friendly error.
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

    // --- The group stage must be finished ---------------------------------
    const groupMatches = await getGroupMatches(tournamentId);

    if (groupMatches.length === 0) {
      return jsonError(
        'No group fixtures exist yet. Run /api/admin/draw-groups first.',
        409,
      );
    }

    if (!isGroupStageComplete(groupMatches)) {
      const remaining = groupMatches.filter(
        (match) => match.status !== 'completed',
      ).length;
      return jsonError(
        `The group stage is not finished yet — ${remaining} fixture(s) still need a result.`,
        409,
      );
    }

    // --- 2. Top two from every group -------------------------------------
    const qualifiers = await getGroupWinners(tournamentId);

    if (qualifiers.length < 4) {
      return jsonError(
        `Only ${qualifiers.length} qualifier(s) were found — at least 4 are needed. Check the group standings.`,
        409,
      );
    }

    // --- 3. Build the bracket rows ---------------------------------------
    const rows = createKnockoutBracket(qualifiers);

    if (rows.length === 0) {
      return jsonError(
        'The matchups could not be built. Make sure every group has a winner and a runner-up.',
        409,
      );
    }

    // --- Guard: never overwrite a bracket that has already been played ----
    const { data: existing } = await supabase
      .from('brackets')
      .select('id, status')
      .eq('tournament_id', tournamentId);

    const existingRows = (existing ?? []) as Array<{ id: string; status: string }>;

    if (existingRows.some((match) => match.status === 'completed')) {
      return jsonError(
        'A knockout match has already been completed, so the bracket can no longer be redrawn.',
        409,
      );
    }

    // Safe to redraw: clear any previous (unplayed) bracket first.
    if (existingRows.length > 0) {
      const { error: clearError } = await supabase
        .from('brackets')
        .delete()
        .eq('tournament_id', tournamentId);

      if (clearError) {
        return handleServerError(
          'draw-knockout',
          clearError,
          'We could not clear the old bracket. Please try again.',
        );
      }
    }

    const { error: insertError } = await supabase.from('brackets').insert(
      rows.map((row) => ({
        tournament_id: tournamentId,
        round: row.round,
        match_number: row.match_number,
        player_a_id: row.player_a_id,
        player_b_id: row.player_b_id,
        status: row.status,
      })),
    );

    if (insertError) {
      return handleServerError(
        'draw-knockout',
        insertError,
        'We could not create the bracket. Please try again.',
      );
    }

    // --- 4. Move the tournament on ---------------------------------------
    const { error: statusError } = await supabase
      .from('tournaments')
      .update({ status: 'bracket_drawn' })
      .eq('id', tournamentId);

    if (statusError) {
      return handleServerError(
        'draw-knockout',
        statusError,
        'The bracket was created but the tournament status could not be updated.',
      );
    }

    // --- Response: the bracket as the page will render it ----------------
    const matchups = await getBracketView(tournamentId);

    return NextResponse.json({ success: true, matchups });
  } catch (error) {
    return handleServerError(
      'draw-knockout',
      error,
      'The knockout draw could not be completed. Please try again.',
    );
  }
}
