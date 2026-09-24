/**
 * POST /api/verify-payment
 *
 * Confirms that Paystack actually received the money, and marks the matching
 * registration as `paid`.
 *
 * This is the only trusted way for a registration to become 'paid' — the
 * browser saying "payment successful" is never enough.
 *
 * Body: { reference: string }
 * Response: { success: boolean, player_name: string, tournament_id?: string }
 */

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import type { VerifyPaymentPayload } from '@/types';
import { handleServerError, jsonError, readJsonBody } from '@/lib/api';
import { isSupabaseConfigured } from '@/lib/supabase';
import { verifyPayment } from '@/lib/paystack';
import { drawWhenTournamentIsFull } from '@/lib/draw';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Verifies a Paystack reference.
 *
 * @param request The incoming request (JSON body = VerifyPaymentPayload).
 * @returns `{ success, player_name }`, or `{ success: false, error }` with a
 *          friendly message.
 */
export async function POST(request: Request) {
  try {
    const body = await readJsonBody<VerifyPaymentPayload>(request);
    const reference = body?.reference?.trim();

    if (!reference) {
      return jsonError('We could not find a payment reference to check.', 400);
    }

    if (!isSupabaseConfigured()) {
      return jsonError(
        'Payments are not available right now. Please contact us on WhatsApp.',
        503,
      );
    }

    const result = await verifyPayment(reference);

    if (!result.success) {
      return jsonError(result.error ?? 'We could not confirm that payment.', 400);
    }

    // Confirming the LAST slot draws the groups right here (lib/draw.ts), so a
    // full tournament has its fixtures before the player's success page loads.
    // Duplicate webhook/callback deliveries cannot draw twice — the database
    // lock in `ensureGroupDraw()` settles it.
    await drawWhenTournamentIsFull(result.tournament_id);

    // Drop the cached pages, so the player who lands on the success page
    // already has a match centre to open.
    revalidatePath('/', 'page');
    if (result.tournament_id) {
      revalidatePath(`/groups/${result.tournament_id}`, 'page');
    }

    return NextResponse.json({
      success: true,
      player_name: result.player_name,
      tournament_id: result.tournament_id ?? null,
    });
  } catch (error) {
    return handleServerError(
      'verify-payment',
      error,
      'We could not confirm that payment. Please contact us on WhatsApp.',
    );
  }
}
