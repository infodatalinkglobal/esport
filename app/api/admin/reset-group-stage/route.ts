/**
 * POST /api/admin/reset-group-stage   (MODULE 4)
 *
 * Automates the one chore the group-draw endpoint used to demand by hand:
 * deleting the groups, members, fixtures and standings rows in Supabase so a
 * tournament can be drawn again (its error message literally told the
 * organizer to do this in the Supabase dashboard).
 *
 * When it is allowed (ONLY while the tournament is `groups_drawn` — before
 * the knockout exists, and never for a completed tournament):
 *   1. every group_match, group_standings, group_member and group row of the
 *      tournament is deleted (children first, in one transaction-ish order),
 *   2. the tournament status drops back to 'open' or 'closed'
 *      (the organizer picks; the default reopens registration).
 *
 * The Matches page counts how many recorded results the reset will destroy and
 * the UI asks for a confirmation, because this is the one button that throws
 * work away on purpose.
 *
 * Protected by the ADMIN_SECRET (`x-admin-secret` header).
 *
 * Body: { tournament_id: string, reopen?: boolean }
 * Response: { success: true, deleted: { groups, matches, results } }
 */

import { handleServerError, isAdminRequest, jsonError, jsonOk, readJsonBody } from '@/lib/api';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Resets one tournament's group stage.
 *
 * @param request The incoming request (body: `{ tournament_id, reopen? }`).
 * @returns What was deleted, or a friendly error.
 */
export async function POST(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return jsonError('Not authorised. Check your admin secret.', 401);
    }

    if (!isSupabaseConfigured()) {
      return jsonError('Supabase is not configured on the server.', 503);
    }

    const body = await readJsonBody<{ tournament_id?: string; reopen?: boolean }>(request);
    const tournamentId = body?.tournament_id?.trim();

    if (!tournamentId) {
      return jsonError('Send the tournament id, e.g. {"tournament_id":"…"}.', 400);
    }

    const supabase = supabaseAdmin();

    // --- The tournament must be exactly at 'groups_drawn' ------------------
    const { data: tournamentRow } = await supabase
      .from('tournaments')
      .select('id, status')
      .eq('id', tournamentId)
      .maybeSingle();

    const tournament = tournamentRow as { id: string; status: string } | null;
    if (!tournament) {
      return jsonError('That tournament could not be found.', 404);
    }

    if (tournament.status !== 'groups_drawn') {
      return jsonError(
        'Only a tournament whose groups have been drawn (and whose knockout has not) can be reset.',
        409,
      );
    }

    // --- Count what is about to be destroyed, for the response -------------
    const { count: resultCount } = await supabase
      .from('group_matches')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId)
      .neq('status', 'pending');

    const { count: matchCount } = await supabase
      .from('group_matches')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId);

    const { count: groupCount } = await supabase
      .from('groups')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId);

    // --- Delete children first, then the groups themselves ------------------
    // (The foreign keys cascade from `groups`, but deleting explicitly means
    // an orphaned half-draw from a crashed attempt is cleaned up too.)
    const deletions = [
      supabase.from('group_matches').delete().eq('tournament_id', tournamentId),
      supabase.from('group_standings').delete().eq('tournament_id', tournamentId),
      supabase.from('group_members').delete().eq('tournament_id', tournamentId),
      supabase.from('groups').delete().eq('tournament_id', tournamentId),
    ];

    for (const deletion of deletions) {
      const { error } = await deletion;
      if (error) {
        console.error('[admin reset-group-stage] delete failed', error.message);
        return jsonError(
          'The reset stopped part-way. Check the tables in Supabase before drawing again.',
          500,
        );
      }
    }

    // --- Back to registration (or stay closed) ------------------------------
    const { error: statusError } = await supabase
      .from('tournaments')
      .update({ status: body?.reopen === false ? 'closed' : 'open' })
      .eq('id', tournamentId);

    if (statusError) {
      console.error('[admin reset-group-stage] status update failed', statusError.message);
      return jsonError(
        'The groups were deleted but the status could not be reset. Set it to "open" in Supabase.',
        500,
      );
    }

    return jsonOk({
      deleted: {
        groups: groupCount ?? 0,
        matches: matchCount ?? 0,
        results: resultCount ?? 0,
      },
    });
  } catch (error) {
    return handleServerError(
      'admin-reset-group-stage',
      error,
      'The group stage could not be reset. Please try again.',
    );
  }
}
