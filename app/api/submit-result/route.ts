/**
 * POST /api/submit-result   (MODULES 2 and 3)
 *
 * Records one player's version of a match result. The body's `kind` decides
 * which flow runs: 'group' (Module 2) or 'knockout' (Module 3). Both share the
 * same rule — BOTH players must submit a screenshot, and the result is confirmed
 * automatically only when the two submissions agree.
 *
 * GROUP MATCHES
 * -------------
 * The rules the tournament is played by:
 * - BOTH players must submit a screenshot of the final scoreboard.
 * - Matching submissions  → the match is auto-confirmed ('completed'), the
 *   winner is set (null for a draw — draws are allowed in the group stage) and
 *   the league table is recalculated immediately.
 * - Conflicting submissions → the match is marked 'disputed' for the organizer
 *   to review within 24 hours.
 * - Only one submission so far → the match stays 'pending' and waits for the
 *   other player. Whoever submitted cannot submit again ("You already submitted
 *   this result").
 *
 * KNOCKOUT MATCHES
 * ----------------
 * Players report "I won" / "I lost" instead of a score. The first claim is kept
 * privately in `brackets.winner_id` (never shown while the match is pending).
 * When the second player submits, `checkAndResolveMatch()` compares the two:
 *   - agree    → 'completed', and the winner is moved into the next round
 *                automatically (winning the Grand Final ends the tournament)
 *   - disagree → 'disputed' for the organizer to review within 24 hours
 *
 * Results are written with the service-role key, because Row Level Security
 * allows the public to read but never to update match rows.
 *
 * Body: SubmitGroupResultPayload | SubmitKnockoutResultPayload
 * Response: SubmitResultResponse
 */

import { NextResponse } from 'next/server';
import type {
  Bracket,
  GroupMatch,
  SubmitGroupResultPayload,
  SubmitKnockoutResultPayload,
} from '@/types';
import { handleServerError, jsonError, readJsonBody } from '@/lib/api';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase';
import { validateGroupResult, validateKnockoutResult } from '@/lib/validation';
import { updateStandings } from '@/lib/groups';
import { checkAndResolveMatch } from '@/lib/bracket';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Handles a group result submission.
 *
 * @param request The incoming request (JSON body = SubmitGroupResultPayload).
 * @returns What happened to the match, with a message the player can read.
 */
export async function POST(request: Request) {
  try {
    // --- 1. Validate -----------------------------------------------------
    const body = await readJsonBody<unknown>(request);

    const rawKind =
      body && typeof body === 'object'
        ? (body as { kind?: string }).kind
        : undefined;

    if (!isSupabaseConfigured()) {
      return jsonError(
        'Result submission is not available right now. Please contact the organizer on WhatsApp.',
        503,
      );
    }

    // --- Knockout branch (Module 3) --------------------------------------
    if (rawKind === 'knockout') {
      const knockoutValidated = validateKnockoutResult(body);

      if (!knockoutValidated.ok) {
        return jsonError(knockoutValidated.error, 400);
      }

      return await submitKnockoutResult(knockoutValidated.value);
    }

    // --- Group branch (Module 2) -----------------------------------------
    const validated = validateGroupResult(body);

    if (!validated.ok) {
      return jsonError(validated.error, 400);
    }

    const payload: SubmitGroupResultPayload = validated.value;
    const supabase = supabaseAdmin();

    // --- 2. Load the fixture ---------------------------------------------
    const { data: matchRow } = await supabase
      .from('group_matches')
      .select('*')
      .eq('id', payload.match_id)
      .maybeSingle();

    if (!matchRow) {
      return jsonError(
        'That match could not be found. Check the fixture list and try again.',
        404,
      );
    }

    const match = matchRow as GroupMatch;

    // --- 3. Is this phone number one of the two players? -----------------
    const { data: playerRows } = await supabase
      .from('registrations')
      .select('id, phone_number')
      .in('id', [match.player_a_id, match.player_b_id]);

    const matchedPlayer = (playerRows ?? []).find(
      (row) => (row.phone_number as string) === payload.phone_number,
    );

    if (!matchedPlayer) {
      return jsonError(
        'Phone number not registered for this match. Use the WhatsApp number you registered with.',
        403,
      );
    }

    const side = matchedPlayer.id === match.player_a_id ? 'a' : 'b';

    // --- 4. Has this player already submitted? ---------------------------
    const alreadySubmitted =
      side === 'a'
        ? Boolean(match.player_a_screenshot)
        : Boolean(match.player_b_screenshot);

    if (alreadySubmitted) {
      return jsonError(
        'You already submitted this result. The organizer will review it if something is wrong.',
        409,
      );
    }

    // --- 5. Has the match already been decided? --------------------------
    if (match.status === 'completed') {
      return jsonError(
        'This result has already been confirmed. Contact the organizer on WhatsApp if it is wrong.',
        409,
      );
    }

    if (match.status === 'disputed') {
      return jsonError(
        'This match is already under review by the organizer (within 24 hours).',
        409,
      );
    }

    // --- 6. Work out whether the two claims agree ------------------------
    const opponentHasSubmitted =
      side === 'a'
        ? Boolean(match.player_b_screenshot)
        : Boolean(match.player_a_screenshot);

    // What the stored row would say if this player's claim is the one kept.
    const claimA = side === 'a' ? payload.my_score : payload.opponent_score;
    const claimB = side === 'a' ? payload.opponent_score : payload.my_score;

    const claimsAgree =
      opponentHasSubmitted &&
      match.player_a_score === claimA &&
      match.player_b_score === claimB;

    // --- 7. Build and save the update ------------------------------------
    const updates: Record<string, unknown> = {
      // The scoreline is only ever stored once BOTH players agree (or the
      // organizer fixes it in the Supabase dashboard), so a disputed match keeps
      // the first claim and relies on the two screenshots as evidence.
      status: 'pending',
    };

    if (side === 'a') {
      updates.player_a_screenshot = payload.screenshot_url;
    } else {
      updates.player_b_screenshot = payload.screenshot_url;
    }

    let confirmed = false;
    let disputed = false;
    let winnerId: string | null = null;

    if (opponentHasSubmitted) {
      if (claimsAgree) {
        confirmed = true;
        winnerId =
          claimA === claimB
            ? null
            : claimA > claimB
              ? match.player_a_id
              : match.player_b_id;

        updates.status = 'completed';
        updates.player_a_score = claimA;
        updates.player_b_score = claimB;
        updates.winner_id = winnerId;
      } else {
        disputed = true;
        updates.status = 'disputed';
        updates.winner_id = null;
      }
    } else {
      // First submission: record the claim so the opponent's submission can be
      // compared against it. The match stays 'pending'.
      updates.player_a_score = claimA;
      updates.player_b_score = claimB;
    }

    const { error: updateError } = await supabase
      .from('group_matches')
      .update(updates)
      .eq('id', match.id);

    if (updateError) {
      return handleServerError(
        'submit-result',
        updateError,
        'We could not save your result. Please try again.',
      );
    }

    // --- 8. Confirmed → recalculate the league table ---------------------
    if (confirmed) {
      await updateStandings({
        ...match,
        player_a_score: claimA,
        player_b_score: claimB,
        status: 'completed',
      });
    }

    return NextResponse.json({
      success: true,
      status: disputed ? 'disputed' : confirmed ? 'completed' : 'pending',
      confirmed,
      disputed,
      winner_id: winnerId,
      message: disputed
        ? 'The two submissions do not match, so this result is disputed — the organizer will review it within 24 hours.'
        : confirmed
          ? 'Both players submitted the same score, so the result is confirmed and the group table has been updated.'
          : 'Your result and screenshot are saved. The match is confirmed as soon as your opponent submits the same score.',
    });
  } catch (error) {
    return handleServerError(
      'submit-result',
      error,
      'We could not save your result. Please try again.',
    );
  }
}

/**
 * Records one player's knockout result and decides the match once both players
 * have submitted.
 *
 * The first player's claim is stored in `brackets.winner_id` while the match is
 * pending; it is never displayed until the match is 'completed', so it cannot
 * give the opponent anything to argue with. The second submission is handed to
 * `checkAndResolveMatch()`, which confirms the winner or marks a dispute and
 * moves the winner into the next round.
 *
 * @param payload The validated knockout submission.
 * @returns What happened to the match, with a message the player can read.
 */
async function submitKnockoutResult(
  payload: SubmitKnockoutResultPayload,
): Promise<NextResponse> {
  const supabase = supabaseAdmin();

  // --- Load the knockout match -------------------------------------------
  const { data: matchRow } = await supabase
    .from('brackets')
    .select('*')
    .eq('id', payload.match_id)
    .maybeSingle();

  if (!matchRow) {
    return jsonError(
      'That match could not be found. Check the bracket and try again.',
      404,
    );
  }

  const match = matchRow as Bracket;

  // --- The match must have both players by now ---------------------------
  if (!match.player_a_id || !match.player_b_id) {
    return jsonError(
      'This match is still waiting for its players. Check back once the previous round is decided.',
      409,
    );
  }

  // --- Is this phone number one of the two players? ----------------------
  const { data: playerRows } = await supabase
    .from('registrations')
    .select('id, phone_number')
    .in('id', [match.player_a_id, match.player_b_id]);

  const matchedPlayer = (playerRows ?? []).find(
    (row) => (row.phone_number as string) === payload.phone_number,
  );

  if (!matchedPlayer) {
    return jsonError(
      'Phone number not registered for this match. Use the WhatsApp number you registered with.',
      403,
    );
  }

  const side = matchedPlayer.id === match.player_a_id ? 'a' : 'b';

  // --- Has this player already submitted? --------------------------------
  const alreadySubmitted =
    side === 'a'
      ? Boolean(match.player_a_screenshot)
      : Boolean(match.player_b_screenshot);

  if (alreadySubmitted) {
    return jsonError(
      'You already submitted this result. The organizer will review it if something is wrong.',
      409,
    );
  }

  if (match.status === 'completed') {
    return jsonError(
      'This result has already been confirmed. Contact the organizer on WhatsApp if it is wrong.',
      409,
    );
  }

  if (match.status === 'disputed') {
    return jsonError(
      'This match is already under review by the organizer (within 24 hours).',
      409,
    );
  }

  // --- Who does this player say won? -------------------------------------
  const myId = matchedPlayer.id as string;
  const opponentId = side === 'a' ? match.player_b_id : match.player_a_id;
  const claimedWinnerId =
    payload.knockout_result === 'won' ? myId : (opponentId as string);

  const opponentHasSubmitted =
    side === 'a'
      ? Boolean(match.player_b_screenshot)
      : Boolean(match.player_a_screenshot);

  const updates: Record<string, unknown> =
    side === 'a'
      ? { player_a_screenshot: payload.screenshot_url }
      : { player_b_screenshot: payload.screenshot_url };

  // First submission: remember the claim privately so the opponent's claim can
  // be compared against it. The match stays 'pending'.
  if (!opponentHasSubmitted && !match.winner_id) {
    updates.winner_id = claimedWinnerId;
  }

  const { error: updateError } = await supabase
    .from('brackets')
    .update(updates)
    .eq('id', match.id);

  if (updateError) {
    return handleServerError(
      'submit-result(knockout)',
      updateError,
      'We could not save your result. Please try again.',
    );
  }

  // --- Decide the match (only does anything once both have submitted) ----
  const resolution = await checkAndResolveMatch(match.id, claimedWinnerId);

  return NextResponse.json({
    success: true,
    status: resolution.status,
    confirmed: resolution.confirmed,
    disputed: resolution.disputed,
    winner_id: resolution.winner_id,
    message: resolution.disputed
      ? 'The two players reported different winners, so this match is disputed — the organizer will review it within 24 hours.'
      : resolution.confirmed
        ? resolution.winner_id === myId
          ? 'Both players agree — you won! The bracket has been updated.'
          : 'Both players agree — your opponent won. The bracket has been updated.'
        : 'Your result and screenshot are saved. The match is confirmed as soon as your opponent submits the same result.',
  });
}
