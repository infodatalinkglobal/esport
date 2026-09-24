/**
 * POST /api/register
 *
 * Creates (or re-uses) a `pending` registration record and returns the details
 * the browser needs to start a Paystack payment.
 *
 * Steps, in order:
 * 1. Validate every field (server-side, never trust the browser).
 * 2. Confirm the tournament is still open and the registration deadline has
 *    not passed.
 * 3. Confirm the tournament is not full (max_players paid players).
 * 4. Reject a phone number that has already *paid*. A number with an
 *    abandoned (pending/failed) registration may try again — we simply refresh
 *    that row instead of blocking the player out of their own slot.
 * 5. Store the registration with status 'pending' and a unique Paystack
 *    reference. This is what the spec means by "on payment initialization:
 *    create registration record with status pending".
 *
 * Body: RegisterPayload
 * Response: { success, registration_id, reference, entry_fee, tournament_title }
 */

import { NextResponse } from 'next/server';
import type { RegisterPayload, Tournament } from '@/types';
import { handleServerError, jsonError, readJsonBody } from '@/lib/api';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';
import { validateRegistration } from '@/lib/validation';
import { buildReference } from '@/lib/paystack';
import { formatCedis } from '@/lib/calculations';
import { isSupportedPlayerCount, MIN_PLAYERS, MAX_PLAYERS } from '@/lib/draw-rules';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Handles a registration submission.
 *
 * @param request The incoming request (JSON body = RegisterPayload).
 * @returns JSON with the registration id and Paystack reference, or a friendly error.
 */
export async function POST(request: Request) {
  try {
    // --- 1. Validate ------------------------------------------------------
    const body = await readJsonBody<unknown>(request);
    const validated = validateRegistration(body);

    if (!validated.ok) {
      return jsonError(validated.error, 400);
    }

    const payload: RegisterPayload = validated.value;

    if (!isSupabaseConfigured()) {
      return jsonError(
        'Registration is not available right now. Please contact us on WhatsApp.',
        503,
      );
    }

    const supabase = supabaseAdmin();

    // --- 2. Tournament must exist and be open -----------------------------
    const { data: tournamentRow } = await supabase
      .from('tournaments')
      .select('*')
      .eq('id', payload.tournament_id)
      .maybeSingle();

    if (!tournamentRow) {
      return jsonError('This tournament could not be found.', 404);
    }

    const tournament = tournamentRow as Tournament;

    if (tournament.status !== 'open') {
      return jsonError('Registration is now closed', 409, { code: 'closed' });
    }

    if (new Date(tournament.registration_deadline).getTime() < Date.now()) {
      return jsonError('Registration is now closed', 409, {
        code: 'deadline_passed',
      });
    }

    // The knockout stage needs 2 or 4 groups; a tournament sized for 9–12
    // players would draw 3 groups and could not be bracketed, and fewer than
    // MIN_PLAYERS (or more than MAX_PLAYERS) cannot be drawn at all. Refuse
    // these sizes at registration so the tournament can never reach a state
    // its own rules cannot finish.
    if (!isSupportedPlayerCount(tournament.max_players)) {
      console.error(
        `[register] tournament ${tournament.id} has unsupported max_players=${tournament.max_players} (allowed: ${MIN_PLAYERS}-8 or 13-${MAX_PLAYERS})`,
      );
      return jsonError(
        'This tournament is misconfigured — contact the organizer on WhatsApp.',
        409,
        { code: 'bad_format' },
      );
    }

    // --- 3. Capacity check -------------------------------------------------
    const { count: paidCount } = await supabase
      .from('registrations')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournament.id)
      .eq('payment_status', 'paid');

    if ((paidCount ?? 0) >= tournament.max_players) {
      return jsonError('Tournament Full — contact us on WhatsApp', 409, {
        code: 'full',
      });
    }

    // --- 4. One registration per phone number ------------------------------
    const { data: existing } = await supabase
      .from('registrations')
      .select('id, payment_status')
      .eq('tournament_id', tournament.id)
      .eq('phone_number', payload.phone_number)
      .maybeSingle();

    if (existing?.payment_status === 'paid') {
      return jsonError('You are already registered', 409, {
        code: 'duplicate',
      });
    }

    // --- 5. Create or refresh the pending registration ---------------------
    const details = {
      player_name: payload.player_name,
      phone_number: payload.phone_number,
      momo_number: payload.momo_number,
      dls_team_name: payload.dls_team_name,
      payment_status: 'pending' as const,
    };

    const registrationId = existing?.id ?? crypto.randomUUID();
    const reference = buildReference(registrationId);

    const { error: writeError } = existing
      ? await supabase
          .from('registrations')
          .update({ ...details, paystack_reference: reference })
          .eq('id', registrationId)
      : await supabase.from('registrations').insert({
          id: registrationId,
          tournament_id: tournament.id,
          ...details,
          paystack_reference: reference,
        });

    if (writeError) {
      // 23505 = unique_violation: the phone number index caught a race.
      if (writeError.code === '23505') {
        return jsonError('You are already registered', 409, {
          code: 'duplicate',
        });
      }
      return handleServerError(
        'register',
        writeError,
        'We could not save your registration. Please try again.',
      );
    }

    return NextResponse.json({
      success: true,
      registration_id: registrationId,
      reference,
      entry_fee: tournament.entry_fee,
      entry_fee_label: formatCedis(tournament.entry_fee),
      tournament_title: tournament.title,
    });
  } catch (error) {
    return handleServerError(
      'register',
      error,
      'We could not complete your registration. Please try again.',
    );
  }
}
