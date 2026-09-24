/**
 * The RULES of result confirmation — pure functions, no database.
 *
 * `app/api/submit-result/route.ts` does the guarded database writes; this file
 * only answers "given the two claims, what should happen?". Keeping the answer
 * here means the most fragile logic in the app — the agree/dispute comparison —
 * can be tested without a Supabase project (see tests/result-rules.test.ts).
 *
 * Both players must submit a screenshot before anything is decided:
 *   group matches    → matching SCORES confirm; conflicting scores dispute;
 *                      equal scores confirm as a draw (no winner)
 *   knockout matches → matching "who won" CLAIMS confirm; conflicting claims
 *                      dispute (knockout matches never draw)
 */

import type { GroupMatch } from '@/types';

/**
 * Compares a submitter's claim against the claim already stored on a group
 * fixture (the first player's submission).
 *
 * @param claimA Score for player A according to the current submitter.
 * @param claimB Score for player B according to the current submitter.
 * @param storedA Score for player A stored by the first submission (null when
 *                nobody has submitted, which can never compare equal).
 * @param storedB Score for player B stored by the first submission.
 * @returns 'confirm' when the two submissions agree, 'dispute' when not.
 */
export function compareGroupClaims(
  claimA: number,
  claimB: number,
  storedA: number | null,
  storedB: number | null,
): 'confirm' | 'dispute' {
  return claimA === storedA && claimB === storedB ? 'confirm' : 'dispute';
}

/**
 * The winner a confirmed group scoreline implies. Draws are allowed in the
 * group stage, so a level score has no winner.
 *
 * @param claimA Player A's score.
 * @param claimB Player B's score.
 * @param playerAId `registrations.id` of player A.
 * @param playerBId `registrations.id` of player B.
 * @returns The winner's id, or null for a draw.
 */
export function groupWinnerId(
  claimA: number,
  claimB: number,
  playerAId: string,
  playerBId: string,
): string | null {
  if (claimA === claimB) return null;
  return claimA > claimB ? playerAId : playerBId;
}

/**
 * Recomputes a `GroupMatch`-shaped row for `updateStandings()` after a
 * confirmation, so the standings recalculation always folds in the scoreline
 * the two players actually agreed on.
 *
 * @param match The fixture as last read from the database.
 * @param claimA Agreed score for player A.
 * @param claimB Agreed score for player B.
 * @returns The row `updateStandings()` expects (completed, scores filled).
 */
export function completedGroupMatch(
  match: GroupMatch,
  claimA: number,
  claimB: number,
): GroupMatch {
  return {
    ...match,
    player_a_score: claimA,
    player_b_score: claimB,
    status: 'completed',
  };
}

/**
 * Compares the two knockout "who won?" claims.
 *
 * @param firstClaim Winner id claimed by the first submitter (stored privately
 *                   in `brackets.winner_id` while the match is pending).
 * @param secondClaim Winner id claimed by the player who just submitted.
 * @returns `{ agreed, winner_id }` — the winner only when both claims name the
 *          same player; knockout matches never draw.
 */
export function resolveKnockoutClaims(
  firstClaim: string | null,
  secondClaim: string | null,
): { agreed: boolean; winner_id: string | null } {
  if (!firstClaim || !secondClaim) {
    return { agreed: false, winner_id: null };
  }
  return firstClaim === secondClaim
    ? { agreed: true, winner_id: firstClaim }
    : { agreed: false, winner_id: null };
}
