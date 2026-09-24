/**
 * The RULES of the automatic group draw — pure functions, no database.
 *
 * `lib/draw.ts` does the writing; this file only answers the question "should
 * the draw run for this tournament?". Keeping the answer here means it can be
 * tested without a Supabase project (`tests/auto-draw.test.ts`), and it keeps
 * the server-only module free of anything a client bundle might reach.
 *
 * The draw is triggered in three places, and all of them ask these rules first:
 *
 *   1. a verified Paystack payment (webhook, browser callback or callback page),
 *   2. a fresh request for the homepage when the tournament is already full,
 *   3. the protected admin route, as the organizer's recovery fallback.
 */

/** Minimum paid players needed for a meaningful groups → knockout tournament. */
export const MIN_PLAYERS = 6;

/** Maximum players this format supports (4 groups of 4). */
export const MAX_PLAYERS = 16;

/** The status a tournament carries once its groups exist. */
export const DRAWN_STATUS = 'groups_drawn';

/**
 * Statuses that prove the group stage is already history.
 *
 * `groups_drawn` is deliberately NOT in this list: on its own it is not proof,
 * because a draw that died half-way leaves the status behind with no groups.
 * The `groups` rows are the real evidence, and an interrupted attempt must stay
 * retryable.
 */
export const LOCKED_STATUSES: string[] = ['bracket_drawn', 'completed'];

/** Why a draw should or should not run. */
export type DrawDecision =
  | 'draw'
  | 'already_drawn'
  | 'not_full'
  | 'not_enough_players'
  | 'too_many_players'
  | 'unsupported_format';

/**
 * How many groups a paid-player count produces (mirrors `getGroupCount()` in
 * lib/groups.ts, which is the function the draw actually uses).
 *
 * The knockout stage crosses groups in PAIRS — A with B, C with D — so the
 * format only works with 2 or 4 groups. A 3-group tournament (9–12 players,
 * because the draw makes groups of 4) would silently strand an entire group's
 * qualifiers with no semifinal to play, so those sizes are refused outright.
 */
export function groupsForPlayerCount(playerCount: number): number {
  if (playerCount <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil(playerCount / 4)));
}

/**
 * True when a player count produces a tournament the knockout stage can finish:
 * 6–8 paid players (2 groups) or 13–16 (4 groups). Used by the draw rules, the
 * registration route (so a mis-sized tournament can never fill up) and the
 * homepage warning.
 *
 * @param playerCount Paid players at draw time, or a tournament's `max_players`.
 * @returns True when the format is playable end to end.
 */
export function isSupportedPlayerCount(playerCount: number): boolean {
  if (!Number.isInteger(playerCount)) return false;
  if (playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) return false;
  const groups = groupsForPlayerCount(playerCount);
  return groups === 2 || groups === 4;
}

/**
 * Decides whether the group draw should run.
 *
 * The order of the checks is the order of the promises:
 *  1. Never draw twice — existing groups, or a tournament that has moved on to
 *     the knockout stage, end the question immediately. That is what makes a
 *     repeated Paystack webhook harmless.
 *  2. Never draw a broken tournament — below the minimum or above the maximum.
 *  3. Only then, is it full enough?
 *
 * @param input.status Current tournament status (may be null on old rows).
 * @param input.existingGroups How many `groups` rows the tournament already has.
 * @param input.paidPlayers How many registrations are `paid`.
 * @param input.maxPlayers The tournament's `max_players`.
 * @param input.requireFull True (default) for the automatic paths: the draw
 *        waits until every slot is paid for. False for the admin fallback,
 *        which may draw as soon as the minimum number of players has paid.
 * @returns `'draw'` when the draw should run, otherwise the reason to skip it.
 *
 * @example
 * // 8/8 paid, nothing drawn yet → 'draw'
 * drawDecision({ status: 'open', existingGroups: 0, paidPlayers: 8, maxPlayers: 8 });
 * // the webhook is delivered a second time → nothing may happen
 * drawDecision({ status: 'groups_drawn', existingGroups: 2, paidPlayers: 8, maxPlayers: 8 });
 * //   → 'already_drawn'
 */
export function drawDecision(input: {
  status: string | null | undefined;
  existingGroups: number;
  paidPlayers: number;
  maxPlayers: number;
  requireFull?: boolean;
}): DrawDecision {
  // Real groups in the database outrank every status value.
  if (input.existingGroups > 0) return 'already_drawn';
  if (LOCKED_STATUSES.includes(input.status ?? '')) return 'already_drawn';
  if (input.paidPlayers < MIN_PLAYERS) return 'not_enough_players';
  if (input.paidPlayers > MAX_PLAYERS) return 'too_many_players';
  // 9–12 paid players would draw 3 groups, which the knockout stage cannot
  // bracket (it crosses groups in pairs) — refusing beats stranding a group.
  if (!isSupportedPlayerCount(input.paidPlayers)) return 'unsupported_format';
  if ((input.requireFull ?? true) && input.paidPlayers < input.maxPlayers) {
    return 'not_full';
  }
  return 'draw';
}
