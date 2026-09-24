/**
 * GET /api/admin/overview   (MODULE 4)
 *
 * One call powering the dashboard's Overview page (and its tournament picker):
 * every tournament with live player counts, plus the selected tournament's
 * payment counts, revenue, prize breakdown, match progress, lifecycle action
 * availability and the newest registrations (private fields included).
 *
 * Protected by the ADMIN_SECRET (`x-admin-secret` header), like every
 * /api/admin route — the payload contains phone numbers and Paystack
 * references, so it must never be public.
 *
 * Query: ?tournament_id=<uuid>  (optional — defaults to the active tournament)
 * Response: { success: true, overview: AdminOverview }
 */

import { handleServerError, isAdminRequest, jsonError, jsonOk } from '@/lib/api';
import { isSupabaseConfigured } from '@/lib/supabase';
import { getAdminOverview } from '@/lib/admin-data';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Loads the overview.
 *
 * @param request The incoming request (the secret is the header).
 * @returns The overview payload, or a friendly error.
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
    const overview = await getAdminOverview(tournamentId);

    if (!overview) {
      return jsonError('No tournaments could be loaded yet.', 404);
    }

    return jsonOk({ overview });
  } catch (error) {
    return handleServerError(
      'admin-overview',
      error,
      'The overview could not be loaded. Please try again.',
    );
  }
}
