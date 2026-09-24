/**
 * GET /api/admin/matches   (MODULE 4)
 *
 * Every match of one tournament — group fixtures and knockout bracket rows —
 * decorated with player names, group names, scores, screenshots and statuses.
 * This is what the admin Matches page renders, including its dispute queue.
 *
 * Protected by the ADMIN_SECRET (`x-admin-secret` header).
 *
 * Query: ?tournament_id=<uuid>  (required)
 * Response: { success: true, matches: AdminMatchRow[] }
 */

import { handleServerError, isAdminRequest, jsonError, jsonOk } from '@/lib/api';
import { isSupabaseConfigured } from '@/lib/supabase';
import { getAdminMatches } from '@/lib/admin-data';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Loads the matches.
 *
 * @param request The incoming request (the secret is the header).
 * @returns The decorated match rows, or a friendly error.
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

    const matches = await getAdminMatches(tournamentId);
    return jsonOk({ matches: matches ?? [] });
  } catch (error) {
    return handleServerError(
      'admin-matches',
      error,
      'The matches could not be loaded. Please try again.',
    );
  }
}
