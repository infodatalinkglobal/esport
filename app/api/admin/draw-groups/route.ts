/**
 * POST /api/admin/draw-groups   (MODULE 2)
 *
 * The group draw, on demand. The draw normally runs by itself the moment the
 * tournament fills up (see `lib/draw.ts` — a verified Paystack payment, or a
 * fresh homepage request for a full tournament, is enough). This endpoint is
 * the RECOVERY FALLBACK for the organizer: use it if a tournament needs to be
 * drawn early by hand, or if an automatic attempt could not be completed.
 *
 * Protected by the ADMIN_SECRET — the MVP has no admin dashboard UI by design,
 * so the organizer calls this with curl/Postman:
 *
 *   curl -X POST https://your-app.vercel.app/api/admin/draw-groups \
 *     -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"tournament_id":"THE-TOURNAMENT-UUID"}'
 *
 * What one draw does:
 *  1. Fetch every PAID registration for the tournament.
 *  2. Shuffle them with Fisher-Yates (a provably fair draw).
 *  3. Split them into groups of 4: 8 players → A & B, 12 → A, B & C,
 *     16 → A, B, C & D.
 *  4. Create the `groups` records.
 *  5. Create the `group_members` records.
 *  6. Generate every round-robin fixture (a group of 4 = 6 matches) and save
 *     them to `group_matches`. Player A is the higher seed who generates the
 *     Friend Match code.
 *  7. Initialise `group_standings` for every player (all zeros).
 *  8. Set the tournament status to 'groups_drawn'.
 *
 * All of that lives in `ensureGroupDraw()`, which is idempotent and safe to run
 * at the same time as an automatic draw: whichever request wins the database
 * lock does the work, the rest report that the groups already exist.
 *
 * Unlike the automatic draw this endpoint may draw a tournament that is not
 * full yet (the minimum is MIN_PLAYERS), because the organizer asked for it.
 *
 * Response: { success: true, groups: GroupDraw[], fixtures_created: number }
 */

import type { GroupDraw } from '@/types';
import { handleServerError, isAdminRequest, jsonError, jsonOk, readJsonBody } from '@/lib/api';
import { isSupabaseConfigured } from '@/lib/supabase';
import { ensureGroupDraw, MAX_PLAYERS, MIN_PLAYERS } from '@/lib/draw';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/** What to tell the organizer when the draw itself failed. */
const FAILURE_MESSAGES: Record<string, string> = {
  tournament: 'We could not read the tournament just now. Please try again.',
  groups: 'We could not create the groups. Nothing was changed — please try again.',
  members:
    'The group members could not be saved, so the draw was rolled back. Please try again.',
  fixtures:
    'The fixtures could not be created, so the draw was rolled back. Please try again.',
  standings:
    'The league tables could not be initialised, so the draw was rolled back. Please try again.',
};

/**
 * Runs the draw and saves it.
 *
 * @param request The incoming request (body: `{ tournament_id }`).
 * @returns The drawn groups with their fixtures, or a friendly error.
 */
export async function POST(request: Request) {
  try {
    // --- Auth: Authorization: Bearer ADMIN_SECRET (x-admin-secret also works) ---
    if (!isAdminRequest(request)) {
      return jsonError('Not authorised. Check your admin secret.', 401);
    }

    const body = await readJsonBody<{ tournament_id?: string }>(request);
    const tournamentId = body?.tournament_id?.trim();

    if (!tournamentId) {
      return jsonError(
        'Send the tournament id in the body, e.g. {"tournament_id":"..."}.',
        400,
      );
    }

    if (!isSupabaseConfigured()) {
      return jsonError('Supabase is not configured on the server.', 503);
    }

    // The organizer may draw before the last slot is paid for.
    const outcome = await ensureGroupDraw(tournamentId, { requireFull: false });

    switch (outcome.reason) {
      case 'draw':
        return jsonOk({
          groups: outcome.groups as GroupDraw[],
          fixtures_created: outcome.fixtures_created,
        });

      case 'already_drawn':
        return jsonError(
          'Groups have already been drawn for this tournament. Delete the groups, group_members, group_matches and group_standings rows in Supabase if you need to redraw.',
          409,
        );

      case 'not_found':
        return jsonError('That tournament could not be found.', 404);

      case 'not_configured':
        return jsonError('Supabase is not configured on the server.', 503);

      case 'in_progress':
        return jsonError(
          'A draw for this tournament is already running. Please try again in a moment.',
          409,
        );

      case 'not_full':
      case 'not_enough_players':
        return jsonError(
          `Only ${outcome.paid_players} paid player(s) so far — you need at least ${MIN_PLAYERS} to draw groups.`,
          409,
        );

      case 'too_many_players':
        return jsonError(
          `This format supports up to ${MAX_PLAYERS} players (found ${outcome.paid_players}).`,
          409,
        );

      default:
        return jsonError(
          FAILURE_MESSAGES[outcome.error_step ?? ''] ??
            'The draw could not be completed. Please try again.',
          500,
        );
    }
  } catch (error) {
    return handleServerError(
      'draw-groups',
      error,
      'The draw could not be completed. Please try again.',
    );
  }
}
