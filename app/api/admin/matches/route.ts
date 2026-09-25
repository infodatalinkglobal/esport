/**
 * GET /api/admin/matches   (MODULE 4)
 *
 * The competitive picture of one tournament in one call:
 *   - every match (group fixtures and knockout bracket rows) decorated with
 *     player names, group names, scores, screenshots and statuses;
 *   - the group standings, ranked exactly like the public groups page ranks
 *     them (with the advancing top-2 flagged) — so the organizer never has
 *     to leave the dashboard to see who tops Group A.
 *
 * This is what the admin Matches page renders, including its dispute queue
 * and its standings/bracket views.
 *
 * Protected by the ADMIN_SECRET (`x-admin-secret` header).
 *
 * Query: ?tournament_id=<uuid>  (required)
 * Response: { success: true, matches: AdminMatchRow[], standings: AdminGroupStandings[] }
 */

import { handleServerError, isAdminRequest, jsonError, jsonOk } from '@/lib/api';
import { isSupabaseConfigured } from '@/lib/supabase';
import { getAdminMatches, getAdminStandings } from '@/lib/admin-data';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Loads the matches and standings.
 *
 * @param request The incoming request (the secret is the header).
 * @returns The decorated match rows and ranked group tables, or a friendly error.
 */
export async function GET(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return jsonError('Not authorised. Check your admin secret.', 401);
    }

    if (!isSupabaseConfigured()) {
      return jsonError('Supabase is not configured on the server.', 503);
    }

    const tournamentId = new URL(request.url).searchParams.get('tournament_id');
    if (!tournamentId) {
      return jsonError('Send the tournament id, e.g. ?tournament_id=….', 400);
    }

    const [matches, standings] = await Promise.all([
      getAdminMatches(tournamentId),
      getAdminStandings(tournamentId),
    ]);

    return jsonOk({
      matches: matches ?? [],
      standings: standings ?? [],
    });
  } catch (error) {
    return handleServerError(
      'admin-matches',
      error,
      'The matches could not be loaded. Please try again.',
    );
  }
}
