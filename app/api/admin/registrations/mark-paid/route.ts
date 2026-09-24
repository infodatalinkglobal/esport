/**
 * POST /api/admin/registrations/mark-paid   (MODULE 4)
 *
 * The organizer's manual payment confirmation — for the player who paid by
 * MoMo transfer outside Paystack, or whose Paystack callback was lost.
 *
 * It reuses the same atomic, capacity-checked `mark_registration_paid()`
 * database function a verified Paystack payment goes through, so:
 *   - two confirmations at the same instant can never oversell a full
 *     tournament (the function locks the tournament row), and
 *   - the answer is "the tournament is full" (and the row stays unpaid) rather
 *     than a silently overbooked bracket.
 *
 * The registration's existing Paystack reference is kept — the RPC only needs
 * a reference to stamp on the row, and inventing a fake one would break the
 * player's payment trail.
 *
 * Guarded like every admin route (ADMIN_SECRET header), plus two rules:
 *   - the registration must belong to a tournament that has not been drawn
 *     yet (a paid player who is in no group would be stranded), and
 *   - 'paid' → 'paid' is idempotent and answers success.
 *
 * Body: { registration_id: string }
 * Response: { success: true, registration_id, payment_status: 'paid' }
 */

import { handleServerError, isAdminRequest, jsonError, jsonOk, readJsonBody } from '@/lib/api';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase';
import type { Registration } from '@/types';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Marks one registration as paid, by hand.
 *
 * @param request The incoming request (body: `{ registration_id }`).
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

    const body = await readJsonBody<{ registration_id?: string }>(request);
    const registrationId = body?.registration_id?.trim();

    if (!registrationId) {
      return jsonError('Send the registration id, e.g. {"registration_id":"…"}.', 400);
    }

    const supabase = supabaseAdmin();

    // --- Load the registration and its tournament ------------------------
    const { data: row, error: loadError } = await supabase
      .from('registrations')
      .select('*')
      .eq('id', registrationId)
      .maybeSingle();

    if (loadError || !row) {
      return jsonError('That registration could not be found.', 404);
    }

    const registration = row as Registration;

    // Idempotent: already paid, nothing to do.
    if (registration.payment_status === 'paid') {
      return jsonOk({ registration_id: registration.id, payment_status: 'paid' });
    }

    const { data: tournamentRow } = await supabase
      .from('tournaments')
      .select('id, status')
      .eq('id', registration.tournament_id)
      .maybeSingle();

    const tournament = tournamentRow as { id: string; status: string } | null;
    if (!tournament) {
      return jsonError('The tournament for this registration no longer exists.', 404);
    }

    if (tournament.status !== 'open' && tournament.status !== 'closed') {
      return jsonError(
        'The groups have already been drawn — this player cannot join anymore. Fix the row in Supabase if you must.',
        409,
      );
    }

    // --- Claim the slot atomically (same path as a verified payment) ------
    const claimed = await supabase.rpc('mark_registration_paid', {
      p_registration_id: registration.id,
      p_reference: registration.paystack_reference,
    });

    if (claimed.error) {
      console.error('[admin mark-paid] rpc failed', claimed.error.message);
      return jsonError('The payment could not be confirmed. Please try again.', 500);
    }

    if (claimed.data !== true) {
      return jsonError(
        'The tournament is already full — this player cannot be added. Refund them.',
        409,
      );
    }

    return jsonOk({ registration_id: registration.id, payment_status: 'paid' });
  } catch (error) {
    return handleServerError(
      'admin-mark-paid',
      error,
      'The payment could not be confirmed. Please try again.',
    );
  }
}
