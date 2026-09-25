/**
 * POST /api/admin/registrations/refund   (MODULE 4)
 *
 * Returns a player's entry fee and frees their slot.
 *
 * Two modes, because money arrives two ways:
 *   - mode 'paystack': the money went through Paystack, so we ask Paystack's
 *     refund API to return it (full amount). Only when Paystack accepts (or
 *     says a refund already exists) is the row marked 'refunded'.
 *   - mode 'manual': the organizer already handed the money back by MoMo —
 *     only the bookkeeping is left, so the row is marked straight away.
 *
 * Guarded like every admin route (ADMIN_SECRET header), plus:
 *   - only `paid` rows can be refunded (no refunding pending/failed/refunded),
 *   - only while the tournament is 'open'/'closed' — once the groups are drawn
 *     the player has fixtures and standings, so the row must stay untouched
 *     (the same rule that freezes mark-paid after the draw).
 *
 * A refunded row stops counting towards the paid slots, so the place frees up
 * for the next player automatically.
 *
 * Body: { registration_id: string, mode: 'paystack' | 'manual' }
 * Response: { success: true, registration_id, payment_status: 'refunded' }
 */

import { handleServerError, isAdminRequest, jsonError, jsonOk, readJsonBody } from '@/lib/api';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase';
import { refundPayment } from '@/lib/paystack';
import { canRefund } from '@/lib/admin-rules';
import type { Registration } from '@/types';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Refunds one registration.
 *
 * @param request The incoming request (body: AdminRefundPayload).
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

    const body = await readJsonBody<{ registration_id?: string; mode?: string }>(request);
    const registrationId = body?.registration_id?.trim();
    const mode = body?.mode === 'manual' ? 'manual' : 'paystack';

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

    const { data: tournamentRow } = await supabase
      .from('tournaments')
      .select('id, status')
      .eq('id', registration.tournament_id)
      .maybeSingle();

    const tournament = tournamentRow as { id: string; status: string } | null;
    if (!tournament) {
      return jsonError('The tournament for this registration no longer exists.', 404);
    }

    if (!canRefund(registration.payment_status, tournament.status as never)) {
      if (registration.payment_status !== 'paid') {
        return jsonError('Only a paid registration can be refunded.', 409);
      }
      return jsonError(
        'The groups have already been drawn — this player has fixtures and cannot be refunded here.',
        409,
      );
    }

    // --- Paystack mode: return the money before touching the row ---------
    if (mode === 'paystack') {
      const outcome = await refundPayment(registration.paystack_reference);

      if (!outcome.ok) {
        return jsonError(
          `${outcome.error} If you have refunded them by hand (MoMo), use “Mark refunded” instead.`,
          409,
        );
      }
    }

    // --- Mark the row refunded (guarded, so a concurrent change wins) -----
    const { error: updateError } = await supabase
      .from('registrations')
      .update({ payment_status: 'refunded' })
      .eq('id', registrationId)
      .eq('payment_status', 'paid');

    if (updateError) {
      console.error('[admin refund] update failed', updateError.message);
      return jsonError('The refund could not be recorded. Please try again.', 500);
    }

    return jsonOk({
      registration_id: registrationId,
      payment_status: 'refunded',
      refunded_via: mode,
    });
  } catch (error) {
    return handleServerError(
      'admin-refund',
      error,
      'The refund could not be completed. Please try again.',
    );
  }
}
