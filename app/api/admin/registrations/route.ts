/**
 * GET /api/admin/registrations   (MODULE 4)
 *
 * The full registration list for one tournament, newest first — the
 * organizer's private view. Unlike the public loaders, this includes phone
 * numbers, MoMo numbers and Paystack references, because contacting players
 * and reconciling payments is exactly what the Players page is for.
 *
 * Protected by the ADMIN_SECRET (`x-admin-secret` header).
 *
 * Query: ?tournament_id=<uuid>  (required)
 * Response: { success: true, registrations: AdminRegistrationRow[] }
 */

import { handleServerError, isAdminRequest, jsonError, jsonOk } from '@/lib/api';
import { isSupabaseConfigured } from '@/lib/supabase';
import { getAdminRegistrations } from '@/lib/admin-data';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Loads the registrations.
 *
 * @param request The incoming request (the secret is the header).
 * @returns The registration rows, or a friendly error.
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

    const registrations = await getAdminRegistrations(tournamentId);
    return jsonOk({ registrations: registrations ?? [] });
  } catch (error) {
    return handleServerError(
      'admin-registrations',
      error,
      'The players could not be loaded. Please try again.',
    );
  }
}
