/**
 * POST /api/paystack/initialize
 *
 * Starts a Paystack transaction for an existing `pending` registration.
 *
 * Paystack is called with the SECRET key here, on the server, so the amount can
 * never be tampered with in the browser. Two things come back and both are sent
 * to the client:
 *
 * - `access_code`    → lets the browser open the payment popup on our own page
 *                      (`resumeTransaction`), which is the mobile-friendly path.
 * - `authorization_url` → the hosted checkout page, used automatically when the
 *                      popup is blocked. See components/PaystackButton.tsx.
 *
 * Body: `{ registration_id: string }`
 * Response: InitializePaymentResponse
 */

import { NextResponse } from 'next/server';
import { handleServerError, jsonError, readJsonBody } from '@/lib/api';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';
import { buildPlayerEmail, buildReference, initializePayment } from '@/lib/paystack';
import { siteUrl } from '@/lib/format';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Initializes (or re-initializes) a payment for a pending registration.
 *
 * @param request The incoming request (JSON body contains `registration_id`).
 * @returns The Paystack reference, access code and redirect URL.
 */
export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{ registration_id?: string }>(request);
    const registrationId = body?.registration_id?.trim();

    if (!registrationId) {
      return jsonError('We could not find your registration. Please register again.', 400);
    }

    if (!isSupabaseConfigured()) {
      return jsonError(
        'Payments are not available right now. Please contact us on WhatsApp.',
        503,
      );
    }

    const publicKey = process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY;
    if (!publicKey) {
      return jsonError(
        'Payments are not configured yet. Please contact us on WhatsApp.',
        503,
      );
    }

    const supabase = supabaseAdmin();

    // --- Load the registration and its tournament --------------------------
    const { data: registration } = await supabase
      .from('registrations')
      .select('id, player_name, phone_number, dls_team_name, payment_status, tournament_id')
      .eq('id', registrationId)
      .maybeSingle();

    if (!registration) {
      return jsonError(
        'We could not find your registration. Please register again.',
        404,
      );
    }

    if (registration.payment_status === 'paid') {
      return jsonError('You have already paid for this tournament.', 409, {
        code: 'already_paid',
      });
    }

    const { data: tournamentRow } = await supabase
      .from('tournaments')
      .select('id, title, entry_fee, max_players')
      .eq('id', registration.tournament_id)
      .maybeSingle();

    if (!tournamentRow) {
      return jsonError('That tournament could not be found.', 404);
    }

    // Re-check the cap right before taking money: the player may have sat on
    // the form while other slots filled. Payment verification enforces this
    // again atomically, but refusing here spares them the payment entirely.
    const { count: paidCount } = await supabase
      .from('registrations')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', registration.tournament_id)
      .eq('payment_status', 'paid');

    if ((paidCount ?? 0) >= (tournamentRow.max_players ?? 0)) {
      return jsonError('Tournament Full — contact us on WhatsApp', 409, {
        code: 'full',
      });
    }

    // --- Create the Paystack transaction -----------------------------------
    // A fresh reference each attempt: Paystack rejects a reference that has
    // already been used, and an abandoned attempt should never block a retry.
    const reference = buildReference(registration.id);
    const email = buildPlayerEmail(registration.phone_number);

    const { error: referenceError } = await supabase
      .from('registrations')
      .update({ paystack_reference: reference })
      .eq('id', registration.id);

    if (referenceError) {
      return handleServerError(
        'paystack.initialize',
        referenceError,
        'We could not start your payment. Please try again.',
      );
    }

    const paystackData = await initializePayment({
      reference,
      amount: tournamentRow.entry_fee as number,
      email,
      // Paystack appends ?reference=... to this URL for us.
      callbackUrl: `${siteUrl()}/payment/verify`,
      metadata: {
        registration_id: registration.id,
        tournament_id: tournamentRow.id,
        player_name: registration.player_name,
        dls_team_name: registration.dls_team_name,
      },
    });

    // Paystack may normalise the reference — keep ours in sync so verification
    // can always find the registration.
    if (paystackData.reference !== reference) {
      await supabase
        .from('registrations')
        .update({ paystack_reference: paystackData.reference })
        .eq('id', registration.id);
    }

    return NextResponse.json({
      success: true,
      reference: paystackData.reference,
      access_code: paystackData.access_code,
      authorization_url: paystackData.authorization_url,
      public_key: publicKey,
      amount: tournamentRow.entry_fee as number,
      email,
      // The popup is the primary flow; the client falls back to the redirect
      // URL above if the popup cannot be shown.
      mode: 'inline' as const,
      tournament_title: tournamentRow.title as string,
    });
  } catch (error) {
    return handleServerError(
      'paystack.initialize',
      error,
      'We could not start your payment. Please try again.',
    );
  }
}
