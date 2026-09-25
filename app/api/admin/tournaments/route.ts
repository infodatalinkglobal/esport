/**
 * POST   /api/admin/tournaments   (MODULE 4) — create the next tournament
 * PATCH  /api/admin/tournaments   (MODULE 4) — edit the selected tournament
 *
 * Creation is how the next cup starts: the new row is 'open' immediately, and
 * because the homepage advertises the NEWEST unfinished tournament, a new row
 * becomes the advertised one right away (the UI says so before you click).
 *
 * Editing is deliberately narrow — every rule lives in
 * `validateTournamentInput()` (lib/admin-rules.ts, tested):
 *   - the entry fee is frozen once registration has closed,
 *   - the size stays a format-supported count (6–8 or 13–16),
 *   - deadlines must be ordered and sane,
 *   - status changes follow the explicit transition map (never past
 *     `groups_drawn`/`bracket_drawn` by hand, and `completed` is one-way).
 * The route adds the one rule the pure validator cannot see: the size can
 * never drop below the number of already-paid players.
 *
 * Protected by the ADMIN_SECRET (`x-admin-secret` header).
 *
 * POST   body: AdminTournamentInput (all fields)
 * PATCH  body: AdminTournamentInput (id + at least one field)
 * Response: { success: true, tournament: Tournament }
 */

import { handleServerError, isAdminRequest, jsonError, jsonOk, readJsonBody } from '@/lib/api';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase';
import { validateTournamentInput } from '@/lib/admin-rules';
import type { Tournament } from '@/types';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Creates a tournament.
 *
 * @param request The incoming request (body: the new tournament's fields).
 * @returns The created row, or a friendly error.
 */
export async function POST(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return jsonError('Not authorised. Check your admin secret.', 401);
    }

    if (!isSupabaseConfigured()) {
      return jsonError('Supabase is not configured on the server.', 503);
    }

    const body = await readJsonBody<unknown>(request);
    const validated = validateTournamentInput(body, { mode: 'create' });

    if (!validated.ok) return jsonError(validated.error, 400);
    const draft = validated.value;

    const { data, error } = await supabaseAdmin()
      .from('tournaments')
      .insert({
        title: draft.title!,
        entry_fee: draft.entry_fee!,
        max_players: draft.max_players!,
        registration_deadline: draft.registration_deadline!,
        match_deadline: draft.match_deadline!,
        status: 'open',
      })
      .select('*')
      .single();

    if (error || !data) {
      console.error('[admin tournaments POST] insert failed', error?.message);
      return jsonError('The tournament could not be created. Please try again.', 500);
    }

    return jsonOk({ tournament: data as Tournament }, 201);
  } catch (error) {
    return handleServerError(
      'admin-tournaments-post',
      error,
      'The tournament could not be created. Please try again.',
    );
  }
}

/**
 * Edits a tournament.
 *
 * @param request The incoming request (body: `{ id, …fields }`).
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

    const supabase = supabaseAdmin();
    const body = await readJsonBody<unknown>(request);

    // Read the id from the raw body first, load the row, then validate once
    // WITH it — the cross-field rules (frozen fee, status transitions) need
    // the current state, so a status change must not fail a shape-only pass.
    const rawId =
      body && typeof body === 'object' && typeof (body as { id?: unknown }).id === 'string'
        ? ((body as { id: string }).id).trim()
        : '';

    if (!rawId) {
      return jsonError('Send the tournament id, e.g. {"id":"…"} plus the fields to change.', 400);
    }

    const { data: currentRow, error: loadError } = await supabase
      .from('tournaments')
      .select('*')
      .eq('id', rawId)
      .maybeSingle();

    if (loadError || !currentRow) {
      return jsonError('That tournament could not be found.', 404);
    }
    const current = currentRow as Tournament;

    const validated = validateTournamentInput(body, { mode: 'patch', current });
    if (!validated.ok) return jsonError(validated.error, 400);
    const patch = validated.value;

    // The size can never drop below the players who already paid.
    if (patch.max_players !== undefined && patch.max_players !== current.max_players) {
      const { count } = await supabase
        .from('registrations')
        .select('id', { count: 'exact', head: true })
        .eq('tournament_id', current.id)
        .eq('payment_status', 'paid');

      if ((count ?? 0) > patch.max_players) {
        return jsonError(
          `${count} player(s) have already paid — the size cannot drop below that.`,
          409,
        );
      }
    }

    const { id, ...fields } = patch;
    const { data, error } = await supabase
      .from('tournaments')
      .update(fields)
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      console.error('[admin tournaments PATCH] update failed', error?.message);
      return jsonError('The tournament could not be updated. Please try again.', 500);
    }

    return jsonOk({ tournament: data as Tournament });
  } catch (error) {
    return handleServerError(
      'admin-tournaments-patch',
      error,
      'The tournament could not be updated. Please try again.',
    );
  }
}
