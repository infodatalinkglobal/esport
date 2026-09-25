/**
 * POST /api/admin/match-result   (MODULE 4)
 *
 * The organizer's word is final: set or override a match result from the
 * dashboard. Its day job is settling the 'disputed' matches the result-rules
 * queue for review, but it can also enter a result nobody submitted.
 *
 * GROUP MATCHES  (kind: 'group', body: { match_id, score_a, score_b })
 *   The scoreline is written as 'completed' (draws allowed), the winner is
 *   derived, and the whole group's league table is recalculated the same way
 *   an agreed player submission recalculates it (`updateStandings`).
 *
 * KNOCKOUT MATCHES  (kind: 'knockout', body: { match_id, winner_id })
 *   The winner is written as 'completed' and moved into the next round
 *   (`advanceWinner`) — winning the Grand Final completes the tournament,
 *   exactly like an agreed player submission would.
 *
 * Guarded like every admin route (ADMIN_SECRET header), plus one hard rule:
 * only 'pending' and 'disputed' matches can be decided. A completed knockout
 * match has already sent its winner onward, so re-deciding it here would
 * corrupt the bracket.
 *
 * Response: { success: true, match_id, status: 'completed' }
 */

import { handleServerError, isAdminRequest, jsonError, jsonOk, readJsonBody } from '@/lib/api';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase';
import { updateStandings } from '@/lib/groups';
import { advanceWinner } from '@/lib/bracket';
import { completedGroupMatch, groupWinnerId } from '@/lib/result-rules';
import { canSetResult, validateAdminMatchResult } from '@/lib/admin-rules';
import type { Bracket, GroupMatch } from '@/types';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Sets one match's result.
 *
 * @param request The incoming request (body: AdminMatchResultPayload).
 * @returns What happened, with a message the organizer can read.
 */
export async function POST(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return jsonError('Not authorised. Check your admin secret.', 401);
    }

    if (!isSupabaseConfigured()) {
      return jsonError('Supabase is not configured on the server.', 503);
    }

    const body = await readJsonBody<unknown>(request);
    const kind =
      body && typeof body === 'object' ? (body as { kind?: unknown }).kind : undefined;
    const supabase = supabaseAdmin();

    // --- Group branch ------------------------------------------------------
    if (kind === 'group') {
      const validated = validateAdminMatchResult(body);
      if (!validated.ok || validated.value.kind !== 'group') {
        return jsonError(validated.ok ? 'Send kind: "group" or "knockout".' : validated.error, 400);
      }

      const { match_id, score_a, score_b } = validated.value;

      const { data: row, error: loadError } = await supabase
        .from('group_matches')
        .select('*')
        .eq('id', match_id)
        .maybeSingle();

      if (loadError || !row) {
        return jsonError('That group match could not be found.', 404);
      }

      const match = row as GroupMatch;

      if (!canSetResult(match.status)) {
        return jsonError(
          'This match is already completed. Group results are final once recorded.',
          409,
        );
      }

      const winnerId = groupWinnerId(score_a, score_b, match.player_a_id, match.player_b_id);

      const { error: updateError } = await supabase
        .from('group_matches')
        .update({
          player_a_score: score_a,
          player_b_score: score_b,
          winner_id: winnerId,
          status: 'completed',
        })
        .eq('id', match_id)
        .eq('status', match.status);

      if (updateError) {
        console.error('[admin match-result] group update failed', updateError.message);
        return jsonError('The result could not be saved. Please try again.', 500);
      }

      // Recalculate the group's league table from every completed match.
      await updateStandings(completedGroupMatch(match, score_a, score_b));

      return jsonOk({ match_id, status: 'completed' });
    }

    // --- Knockout branch ----------------------------------------------------
    // (A kind that is neither 'group' nor 'knockout' fails validation here.)
    const knockoutPreCheck = validateAdminMatchResult(body);
    if (!knockoutPreCheck.ok || knockoutPreCheck.value.kind !== 'knockout') {
      return jsonError(
        knockoutPreCheck.ok ? 'Send kind: "group" or "knockout".' : knockoutPreCheck.error,
        400,
      );
    }

    const { match_id } = knockoutPreCheck.value;

    const { data: row, error: loadError } = await supabase
      .from('brackets')
      .select('*')
      .eq('id', match_id)
      .maybeSingle();

    if (loadError || !row) {
      return jsonError('That knockout match could not be found.', 404);
    }

    const match = row as Bracket;

    if (!canSetResult(match.status)) {
      return jsonError(
        'This match is already completed and its winner has advanced — the bracket cannot be re-decided here.',
        409,
      );
    }

    // The winner must be one of the two players actually in the match.
    const knockoutValidated = validateAdminMatchResult(body, {
      player_a_id: match.player_a_id,
      player_b_id: match.player_b_id,
    });
    if (!knockoutValidated.ok || knockoutValidated.value.kind !== 'knockout') {
      return jsonError(
        knockoutValidated.ok ? 'Send kind: "group" or "knockout".' : knockoutValidated.error,
        400,
      );
    }
    const { winner_id } = knockoutValidated.value;

    const { error: updateError } = await supabase
      .from('brackets')
      .update({ winner_id, status: 'completed' })
      .eq('id', match_id)
      .eq('status', match.status);

    if (updateError) {
      console.error('[admin match-result] knockout update failed', updateError.message);
      return jsonError('The result could not be saved. Please try again.', 500);
    }

    // Move the winner into the next round (or complete the tournament).
    await advanceWinner({ ...match, status: 'completed', winner_id }, winner_id);

    return jsonOk({ match_id, status: 'completed' });
  } catch (error) {
    return handleServerError(
      'admin-match-result',
      error,
      'The result could not be saved. Please try again.',
    );
  }
}
