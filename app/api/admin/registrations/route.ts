/**
 * GET   /api/admin/registrations   (MODULE 4) — the full player list
 * PATCH /api/admin/registrations   (MODULE 4) — fix a player's details
 *
 * GET returns the full registration list for one tournament, newest first —
 * the organizer's private view. Unlike the public loaders, this includes phone
 * numbers, MoMo numbers and Paystack references, because contacting players
 * and reconciling payments is exactly what the Players page is for.
 *
 * PATCH edits the identity/contact fields of one registration: name, DLS team,
 * WhatsApp number, MoMo number. Payment status is deliberately NOT editable
 * here — money state has its own dedicated flows (mark-paid, refund), each
 * with its own guard rails. Changing the WhatsApp number checks the
 * one-phone-per-tournament rule against the database.
 *
 * Protected by the ADMIN_SECRET (`x-admin-secret` header).
 *
 * GET    query: ?tournament_id=<uuid>  (required)
 * PATCH  body:  { id, player_name?, dls_team_name?, phone_number?, momo_number? }
 * Response: { success: true, registrations? , registration? }
 */

import { handleServerError, isAdminRequest, jsonError, jsonOk, readJsonBody } from '@/lib/api';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase';
import { getAdminRegistrations } from '@/lib/admin-data';
import { validateRegistrationInput } from '@/lib/admin-rules';
import type { Registration } from '@/types';

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

/**
 * Edits one registration's identity/contact details.
 *
 * @param request The incoming request (body: AdminRegistrationInput).
 * @returns The updated row, or a friendly error.
 */
export async function PATCH(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return jsonError('Not authorised. Check your admin secret.', 401);
    }

    if (!isSupabaseConfigured()) {
      return jsonError('Supabase is not configured on the server.', 503);
    }

    const body = await readJsonBody<unknown>(request);
    const validated = validateRegistrationInput(body);
    if (!validated.ok) return jsonError(validated.error, 400);

    const { id, ...fields } = validated.value;
    const supabase = supabaseAdmin();

    // --- The registration must exist -------------------------------------
    const { data: row, error: loadError } = await supabase
      .from('registrations')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (loadError || !row) {
      return jsonError('That registration could not be found.', 404);
    }
    const current = row as Registration;

    // --- A new WhatsApp number must stay unique inside the tournament -----
    if (fields.phone_number && fields.phone_number !== current.phone_number) {
      const { data: clash } = await supabase
        .from('registrations')
        .select('id, player_name')
        .eq('tournament_id', current.tournament_id)
        .eq('phone_number', fields.phone_number)
        .maybeSingle();

      if (clash) {
        return jsonError(
          `That WhatsApp number is already registered in this tournament (${
            (clash as { player_name: string }).player_name
          }).`,
          409,
        );
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('registrations')
      .update(fields)
      .eq('id', id)
      .select('*')
      .single();

    if (updateError || !updated) {
      console.error('[admin registrations PATCH] update failed', updateError?.message);
      return jsonError('The player could not be updated. Please try again.', 500);
    }

    return jsonOk({ registration: updated as Registration });
  } catch (error) {
    return handleServerError(
      'admin-registrations-patch',
      error,
      'The player could not be updated. Please try again.',
    );
  }
}
