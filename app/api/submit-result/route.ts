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
import {
  compareGroupClaims,
  completedGroupMatch,
  groupWinnerId,
} from '@/lib/result-rules';

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

    // --- 6. Write the submission with guards against concurrent submits -----
    // Both players finishing their game at the same time is the normal case.
    // The old read-then-write flow let two simultaneous "first submissions"
    // overwrite each other's claim and leave the match pending forever, so
    // every write below is conditional and the flow re-reads on any miss.
    // Postgres re-evaluates the WHERE after waiting on a concurrent writer's
    // row lock, so exactly one of two racing writes can land.
    const myShotColumn = side === 'a' ? 'player_a_screenshot' : 'player_b_screenshot';
    const opponentShotColumn = side === 'a' ? 'player_b_screenshot' : 'player_a_screenshot';

    const claimA = side === 'a' ? payload.my_score : payload.opponent_score;
    const claimB = side === 'a' ? payload.opponent_score : payload.my_score;

    // Up to two rounds of: try the FIRST-submission write (my screenshot + my
    // claim, neither player may have submitted yet) — if it misses, re-read and
    // either resolve as the second submitter or retry once.
    let current: GroupMatch | null = null;
    let opponentSubmitted = false;

    for (let attempt = 0; attempt < 2 && !opponentSubmitted; attempt += 1) {
      const firstWrite = await supabase
        .from('group_matches')
        .update({
          [myShotColumn]: payload.screenshot_url,
          player_a_score: claimA,
          player_b_score: claimB,
          status: 'pending',
        })
        .eq('id', match.id)
        .eq('status', 'pending')
        .is(myShotColumn, null)
        .is(opponentShotColumn, null)
        .select('id');

      if (firstWrite.error) {
        return handleServerError(
          'submit-result',
          firstWrite.error,
          'We could not save your result. Please try again.',
        );
      }

      if (firstWrite.data && firstWrite.data.length > 0) {
        // We are genuinely first — the opponent's submission will be compared
        // against this claim.
        return NextResponse.json({
          success: true,
          status: 'pending',
          confirmed: false,
          disputed: false,
          winner_id: null,
          message:
            'Your result and screenshot are saved. The match is confirmed as soon as your opponent submits the same score.',
        });
      }

      // The guarded write missed: the state changed under us. Re-read.
      const { data: freshRow, error: freshError } = await supabase
        .from('group_matches')
        .select('*')
        .eq('id', match.id)
        .maybeSingle();

      if (freshError || !freshRow) {
        return handleServerError(
          'submit-result',
          freshError ?? 'match vanished mid-submission',
          'We could not save your result. Please try again.',
        );
      }

      current = freshRow as GroupMatch;

      if (side === 'a' ? current.player_a_screenshot : current.player_b_screenshot) {
        return jsonError(
          'You already submitted this result. The organizer will review it if something is wrong.',
          409,
        );
      }

      if (current.status === 'completed') {
        return jsonError(
          'This result has already been confirmed. Contact the organizer on WhatsApp if it is wrong.',
          409,
        );
      }

      if (current.status === 'disputed') {
        return jsonError(
          'This match is already under review by the organizer (within 24 hours).',
          409,
        );
      }

      opponentSubmitted = Boolean(
        side === 'a'
          ? current.player_b_screenshot
          : current.player_a_screenshot,
      );
    }

    if (!current) {
      return handleServerError(
        'submit-result',
        'unreachable: submission loop produced no match row',
        'We could not save your result. Please try again.',
      );
    }

    if (!opponentSubmitted) {
      // Two attempts and the match is still untouched — a transient database
      // condition. A clean retry works.
      return jsonError(
        'We could not save your result just now. Please try again in a moment.',
        503,
      );
    }

    // --- 6c. Compare my claim with the stored one and write the outcome,
    //     guarded on the match still being pending. ---
    const outcome = compareGroupClaims(
      claimA,
      claimB,
      current.player_a_score,
      current.player_b_score,
    );

    if (outcome === 'confirm') {
      const winnerId = groupWinnerId(
        claimA,
        claimB,
        match.player_a_id,
        match.player_b_id,
      );

      const confirmWrite = await supabase
        .from('group_matches')
        .update({
          [myShotColumn]: payload.screenshot_url,
          player_a_score: claimA,
          player_b_score: claimB,
          winner_id: winnerId,
          status: 'completed',
        })
        .eq('id', match.id)
        .eq('status', 'pending')
        .select('id');

      if (confirmWrite.error) {
        return handleServerError(
          'submit-result',
          confirmWrite.error,
          'We could not save your result. Please try again.',
        );
      }

      if (confirmWrite.data && confirmWrite.data.length > 0) {
        // --- 7. Confirmed → recalculate the league table ---
        await updateStandings(completedGroupMatch(match, claimA, claimB));

        return NextResponse.json({
          success: true,
          status: 'completed',
          confirmed: true,
          disputed: false,
          winner_id: winnerId,
          message:
            'Both players submitted the same score, so the result is confirmed and the group table has been updated.',
        });
      }

      // The match was resolved between our read and write — report reality.
      const { data: resolvedRow } = await supabase
        .from('group_matches')
        .select('status')
        .eq('id', match.id)
        .maybeSingle();

      if (resolvedRow?.status === 'completed') {
        return jsonError(
          'This result has already been confirmed. Contact the organizer on WhatsApp if it is wrong.',
          409,
        );
      }

      return jsonError(
        'This match is already under review by the organizer (within 24 hours).',
        409,
      );
    }

    // Conflicting claims → the organizer takes over.
    const disputeWrite = await supabase
      .from('group_matches')
      .update({
        [myShotColumn]: payload.screenshot_url,
        status: 'disputed',
        winner_id: null,
      })
      .eq('id', match.id)
      .eq('status', 'pending')
      .select('id');

    if (disputeWrite.error) {
      return handleServerError(
        'submit-result',
        disputeWrite.error,
        'We could not save your result. Please try again.',
      );
    }

    return NextResponse.json({
      success: true,
      status: 'disputed',
      confirmed: false,
      disputed: true,
      winner_id: null,
      message:
        'The two submissions do not match, so this result is disputed — the organizer will review it within 24 hours.',
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

  const myShotColumn = side === 'a' ? 'player_a_screenshot' : 'player_b_screenshot';
  const opponentShotColumn = side === 'a' ? 'player_b_screenshot' : 'player_a_screenshot';

  // --- First-submission attempt: store my screenshot AND my claim privately.
  // The guards (no screenshots, no stored claim) make simultaneous submissions
  // serialise — the old unconditional write let two racing submissions overwrite
  // the stored claim and manufacture a false dispute. Postgres re-evaluates the
  // WHERE after waiting on the concurrent writer's lock, so only one lands.
  const firstWrite = await supabase
    .from('brackets')
    .update({
      [myShotColumn]: payload.screenshot_url,
      winner_id: claimedWinnerId,
    })
    .eq('id', match.id)
    .eq('status', 'pending')
    .is('winner_id', null)
    .is(myShotColumn, null)
    .is(opponentShotColumn, null)
    .select('id');

  if (firstWrite.error) {
    return handleServerError(
      'submit-result(knockout)',
      firstWrite.error,
      'We could not save your result. Please try again.',
    );
  }

  if (firstWrite.data && firstWrite.data.length > 0) {
    // We stored the first claim. Nothing to decide yet — the opponent's
    // submission will be compared against it.
    return NextResponse.json({
      success: true,
      status: 'pending',
      confirmed: false,
      disputed: false,
      winner_id: null,
      message:
        'Your result and screenshot are saved. The match is confirmed as soon as your opponent submits the same result.',
    });
  }

  // --- The guarded write missed: state changed under us. Re-read. ---------
  const { data: freshRow, error: freshError } = await supabase
    .from('brackets')
    .select('*')
    .eq('id', match.id)
    .maybeSingle();

  if (freshError || !freshRow) {
    return handleServerError(
      'submit-result(knockout)',
      freshError ?? 'match vanished mid-submission',
      'We could not save your result. Please try again.',
    );
  }

  const current = freshRow as Bracket;

  if (side === 'a' ? current.player_a_screenshot : current.player_b_screenshot) {
    return jsonError(
      'You already submitted this result. The organizer will review it if something is wrong.',
      409,
    );
  }

  if (current.status === 'completed') {
    return jsonError(
      'This result has already been confirmed. Contact the organizer on WhatsApp if it is wrong.',
      409,
    );
  }

  if (current.status === 'disputed') {
    return jsonError(
      'This match is already under review by the organizer (within 24 hours).',
      409,
    );
  }

  // --- Second-submitter path: store my screenshot (guarded), then let
  //     checkAndResolveMatch compare my claim with the stored one. ---
  const secondWrite = await supabase
    .from('brackets')
    .update({ [myShotColumn]: payload.screenshot_url })
    .eq('id', match.id)
    .eq('status', 'pending')
    .is(myShotColumn, null)
    .select('id');

  if (secondWrite.error) {
    return handleServerError(
      'submit-result(knockout)',
      secondWrite.error,
      'We could not save your result. Please try again.',
    );
  }

  if (!secondWrite.data || secondWrite.data.length === 0) {
    // Resolved between our read and write — report the row as it stands.
    const { data: resolvedRow } = await supabase
      .from('brackets')
      .select('status')
      .eq('id', match.id)
      .maybeSingle();

    if (resolvedRow?.status === 'completed') {
      return jsonError(
        'This result has already been confirmed. Contact the organizer on WhatsApp if it is wrong.',
        409,
      );
    }

    return jsonError(
      'This match is already under review by the organizer (within 24 hours).',
      409,
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
