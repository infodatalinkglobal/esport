/**
 * The RULES of the admin dashboard — pure functions, no database.
 *
 * `lib/admin-data.ts` loads rows and `app/api/admin/*` writes them; this file
 * only answers the questions every screen of the dashboard asks:
 *
 *   - "What are the stats for these rows?"            → countPayments/countMatches
 *   - "Which lifecycle buttons may I press?"          → adminActionAvailability
 *   - "May the status change from A to B?"            → canChangeStatus
 *   - "Is this organizer input valid?"                → validateTournamentInput /
 *                                                      validateAdminMatchResult
 *
 * Keeping the answers here (the same pattern as `lib/draw-rules.ts` and
 * `lib/result-rules.ts`) means the guard rails of the dashboard can be tested
 * without a Supabase project — see `tests/admin-rules.test.ts`.
 */

import type {
  AdminActionAvailability,
  AdminActionState,
  AdminMatchCounts,
  AdminMatchResultPayload,
  AdminTournamentInput,
  MatchStatus,
  PaymentStatus,
  Registration,
  Tournament,
  TournamentStatus,
} from '@/types';
import type { ValidationResult } from './validation';
import { isSupportedPlayerCount, MIN_PLAYERS } from './draw-rules';

/* ==========================================================================
 * Status transitions
 * ========================================================================== */

/**
 * The legal tournament status changes the organizer may make BY HAND.
 *
 * The interesting transitions are deliberately NOT here, because they must go
 * through the endpoints that own them:
 *   - `→ groups_drawn`  only via the group draw (it creates the groups)
 *   - `→ bracket_drawn` only via the knockout draw (it creates the bracket)
 * `completed` is a one-way door: history on the Champions page is never edited.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<TournamentStatus, TournamentStatus[]> = {
  open: ['closed'],
  closed: ['open', 'completed'],
  groups_drawn: ['completed'],
  bracket_drawn: ['completed'],
  completed: [],
};

/**
 * Whether the organizer may move a tournament between two statuses by hand.
 *
 * @param from The tournament's current status.
 * @param to The requested status.
 * @returns True when the transition is in {@link ALLOWED_STATUS_TRANSITIONS}.
 */
export function canChangeStatus(from: TournamentStatus, to: TournamentStatus): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/* ==========================================================================
 * Stats from raw rows
 * ========================================================================== */

/**
 * Counts registrations by payment status.
 *
 * @param rows Registration rows (only `payment_status` is read).
 * @returns `{ paid, pending, failed }` counts.
 */
export function countPayments(
  rows: Array<Pick<Registration, 'payment_status'>>,
): { paid: number; pending: number; failed: number } {
  const counts = { paid: 0, pending: 0, failed: 0 };
  for (const row of rows) {
    if (row.payment_status === 'paid') counts.paid += 1;
    else if (row.payment_status === 'pending') counts.pending += 1;
    else if (row.payment_status === 'failed') counts.failed += 1;
  }
  return counts;
}

/**
 * Counts matches by status.
 *
 * @param rows Match rows (only `status` is read).
 * @returns The `{ total, pending, completed, disputed }` counts.
 */
export function countMatches(
  rows: Array<Pick<GroupMatchLike, 'status'>>,
): AdminMatchCounts {
  const counts: AdminMatchCounts = { total: rows.length, pending: 0, completed: 0, disputed: 0 };
  for (const row of rows) {
    if (row.status === 'pending') counts.pending += 1;
    else if (row.status === 'completed') counts.completed += 1;
    else if (row.status === 'disputed') counts.disputed += 1;
  }
  return counts;
}

/** The sliver of a match row the counters need. */
interface GroupMatchLike {
  status: MatchStatus;
}

/* ==========================================================================
 * Lifecycle action availability
 * ========================================================================== */

/** The inputs the availability rules need, all already loaded by the overview. */
export interface AdminActionInputs {
  tournament: Pick<Tournament, 'status' | 'max_players' | 'registration_deadline'>;
  payment_counts: { paid: number; pending: number };
  group_matches: AdminMatchCounts;
  knockout_matches: AdminMatchCounts;
}

/** Shorthand for building one action's state. */
function action(allowed: boolean, reason = ''): AdminActionState {
  return { allowed, reason };
}

/**
 * Decides which lifecycle buttons the Overview page may offer, and writes the
 * human sentence shown under every disabled one.
 *
 * The rules mirror what the write endpoints enforce, so a button is never
 * enabled for something the API would refuse (and never disabled for something
 * the API would happily do).
 *
 * @param inputs The tournament, payment counts and match counts.
 * @returns The availability of every lifecycle action.
 */
export function adminActionAvailability(inputs: AdminActionInputs): AdminActionAvailability {
  const { tournament, payment_counts, group_matches, knockout_matches } = inputs;
  const status = tournament.status;

  // --- Registration open/close -----------------------------------------
  const close_registration =
    status === 'open'
      ? action(true)
      : action(false, 'Registration is already closed for this tournament.');

  const reopen_registration =
    status === 'closed'
      ? action(true)
      : action(false, 'Only a closed tournament can be reopened.');

  // --- Draw the groups ---------------------------------------------------
  let draw_groups: AdminActionState;
  if (status === 'open' || status === 'closed') {
    if (payment_counts.paid < MIN_PLAYERS) {
      draw_groups = action(
        false,
        `At least ${MIN_PLAYERS} paid players are needed — ${payment_counts.paid} so far.`,
      );
    } else {
      draw_groups = action(true);
    }
  } else if (status === 'groups_drawn') {
    draw_groups = action(false, 'Groups already exist. Reset the group stage to redraw.');
  } else {
    draw_groups = action(false, 'This tournament has moved past the group stage.');
  }

  // --- Draw the knockout -------------------------------------------------
  let draw_knockout: AdminActionState;
  if (status === 'groups_drawn') {
    if (group_matches.total === 0) {
      draw_knockout = action(false, 'No group fixtures exist yet.');
    } else if (group_matches.pending > 0 || group_matches.disputed > 0) {
      const unfinished = group_matches.pending + group_matches.disputed;
      draw_knockout = action(
        false,
        `${unfinished} group fixture(s) still need a confirmed result.`,
      );
    } else {
      draw_knockout = action(true);
    }
  } else if (status === 'bracket_drawn' || status === 'completed') {
    draw_knockout = action(false, 'The knockout stage has already been drawn.');
  } else {
    draw_knockout = action(false, 'Draw the groups first.');
  }

  // --- Reset the group stage ---------------------------------------------
  let reset_group_stage: AdminActionState;
  if (status === 'groups_drawn') {
    const played = group_matches.completed + group_matches.disputed;
    reset_group_stage = action(
      true,
      played > 0
        ? `Destroys ${played} recorded group result(s) so the draw can be redone.`
        : 'No results recorded yet — safe to redraw.',
    );
  } else if (status === 'bracket_drawn' || status === 'completed') {
    reset_group_stage = action(false, 'The knockout stage already exists.');
  } else {
    reset_group_stage = action(false, 'Groups have not been drawn yet.');
  }

  // --- Mark completed ------------------------------------------------------
  const mark_completed =
    status === 'groups_drawn' || status === 'bracket_drawn'
      ? action(true)
      : action(
          false,
          status === 'completed'
            ? 'This tournament is already completed.'
            : 'Close registration first, or let the Grand Final decide it.',
        );

  // --- Edit settings -------------------------------------------------------
  const edit_settings =
    status === 'open' || status === 'closed'
      ? action(true)
      : action(
          false,
          status === 'completed'
            ? 'Completed tournaments are history and cannot be edited.'
            : 'Fixtures already exist — only results can change now.',
        );

  return {
    close_registration,
    reopen_registration,
    draw_groups,
    draw_knockout,
    reset_group_stage,
    mark_completed,
    edit_settings,
  };
}

/* ==========================================================================
 * Input validation
 * ========================================================================== */

/** Longest tournament title we accept. */
export const MAX_TITLE_LENGTH = 80;

/** Entry fee bounds, in pesewas: GH₵1 – GH₵1,000. */
export const MIN_ENTRY_FEE_PESEWAS = 100;
export const MAX_ENTRY_FEE_PESEWAS = 100_000;

/** The maximum distance ahead a deadline may be set (about 1 year). */
const MAX_DEADLINE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Parses and validates the organizer's tournament form.
 *
 * A create needs every field; a patch needs the id plus at least one field.
 * The rules the form cannot see are enforced against `current`:
 *   - the entry fee is frozen once anyone has paid (two fees never mix), and
 *   - `max_players` can never fall below the paid count, and must stay a
 *     size the knockout format can finish (see `isSupportedPlayerCount`).
 *
 * @param input The raw request body.
 * @param options `mode: 'create' | 'patch'` and the current tournament row
 *                (patch only), for the cross-field rules.
 * @returns The cleaned input, or a message safe to show the organizer.
 */
export function validateTournamentInput(
  input: unknown,
  options: { mode: 'create' | 'patch'; current?: Tournament | null },
): ValidationResult<AdminTournamentInput> {
  const { mode, current } = options;

  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Send the tournament details as a JSON object.' };
  }

  const body = input as Record<string, unknown>;
  const cleaned: AdminTournamentInput = {};

  // --- id (patch only) ---------------------------------------------------
  if (mode === 'patch') {
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) return { ok: false, error: 'Send the tournament id, e.g. {"id":"…"}.' };
    cleaned.id = id;
  }

  // --- title --------------------------------------------------------------
  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim().replace(/\s+/g, ' ') : '';
    if (title.length < 3 || title.length > MAX_TITLE_LENGTH) {
      return {
        ok: false,
        error: `The title must be 3–${MAX_TITLE_LENGTH} characters long.`,
      };
    }
    cleaned.title = title;
  } else if (mode === 'create') {
    return { ok: false, error: 'A tournament needs a title.' };
  }

  // --- entry fee ------------------------------------------------------------
  if (body.entry_fee !== undefined) {
    const fee = body.entry_fee;
    if (typeof fee !== 'number' || !Number.isInteger(fee)) {
      return { ok: false, error: 'The entry fee must be a whole number of pesewas (GH₵10 = 1000).' };
    }
    if (fee < MIN_ENTRY_FEE_PESEWAS || fee > MAX_ENTRY_FEE_PESEWAS) {
      return {
        ok: false,
        error: `The entry fee must be between GH₵${MIN_ENTRY_FEE_PESEWAS / 100} and GH₵${MAX_ENTRY_FEE_PESEWAS / 100}.`,
      };
    }
    if (current && current.status !== 'open') {
      return {
        ok: false,
        error: 'The entry fee cannot change once registration has closed.',
      };
    }
    cleaned.entry_fee = fee;
  } else if (mode === 'create') {
    return { ok: false, error: 'A tournament needs an entry fee in pesewas (GH₵10 = 1000).' };
  }

  // --- max players ------------------------------------------------------------
  if (body.max_players !== undefined) {
    const maxPlayers = body.max_players;
    if (typeof maxPlayers !== 'number' || !Number.isInteger(maxPlayers)) {
      return { ok: false, error: 'Max players must be a whole number.' };
    }
    if (!isSupportedPlayerCount(maxPlayers)) {
      return {
        ok: false,
        error:
          'This format needs 6–8 players (2 groups) or 13–16 players (4 groups) — 9–12 would strand a whole group with no semifinal.',
      };
    }
    if (current && current.max_players !== maxPlayers && current.status !== 'open' && current.status !== 'closed') {
      return {
        ok: false,
        error: 'The size cannot change once the groups have been drawn — they are drawn from it.',
      };
    }
    cleaned.max_players = maxPlayers;
  } else if (mode === 'create') {
    return { ok: false, error: 'A tournament needs a max player count (6–8 or 13–16).' };
  }

  // --- deadlines -----------------------------------------------------------------
  const deadline = (value: unknown, label: string): ValidationResult<string> => {
    if (typeof value !== 'string' || !value.trim()) {
      return { ok: false, error: `A tournament needs a ${label} deadline.` };
    }
    const time = Date.parse(value);
    if (Number.isNaN(time)) {
      return { ok: false, error: `The ${label} deadline could not be read as a date.` };
    }
    if (time < Date.now() - 24 * 60 * 60 * 1000) {
      return { ok: false, error: `The ${label} deadline cannot be in the past.` };
    }
    if (time > Date.now() + MAX_DEADLINE_AHEAD_MS) {
      return { ok: false, error: `The ${label} deadline must be within the next year.` };
    }
    return { ok: true, value: new Date(time).toISOString() };
  };

  if (body.registration_deadline !== undefined || mode === 'create') {
    const parsed = deadline(body.registration_deadline, 'registration');
    if (!parsed.ok) return parsed;
    cleaned.registration_deadline = parsed.value;
  }

  if (body.match_deadline !== undefined || mode === 'create') {
    const parsed = deadline(body.match_deadline, 'match');
    if (!parsed.ok) return parsed;
    cleaned.match_deadline = parsed.value;
  }

  if (
    cleaned.registration_deadline &&
    cleaned.match_deadline &&
    Date.parse(cleaned.match_deadline) <= Date.parse(cleaned.registration_deadline)
  ) {
    return { ok: false, error: 'The match deadline must be after the registration deadline.' };
  }

  // --- status (patch only) ----------------------------------------------------------
  if (body.status !== undefined) {
    const status = body.status;
    const STATUSES: TournamentStatus[] = [
      'open',
      'closed',
      'groups_drawn',
      'bracket_drawn',
      'completed',
    ];
    if (typeof status !== 'string' || !STATUSES.includes(status as TournamentStatus)) {
      return { ok: false, error: 'Unknown tournament status.' };
    }
    if (!current) {
      return { ok: false, error: 'Status changes need the current tournament.' };
    }
    if (status !== current.status && !canChangeStatus(current.status, status as TournamentStatus)) {
      return {
        ok: false,
        error: `A ${current.status} tournament cannot be moved to “${status}” by hand. Use the draw or reset actions instead.`,
      };
    }
    cleaned.status = status as TournamentStatus;
  }

  // --- a patch must change something --------------------------------------------
  if (mode === 'patch' && Object.keys(cleaned).length <= 1) {
    return { ok: false, error: 'Nothing to update — send at least one field besides the id.' };
  }

  return { ok: true, value: cleaned };
}

/**
 * What a validated organizer result submission looks like — a discriminated
 * union, so the caller can never read a knockout's `winner_id` off a group
 * payload (or vice versa) without the compiler noticing.
 */
export type ValidatedAdminMatchResult =
  | { kind: 'group'; match_id: string; score_a: number; score_b: number }
  | { kind: 'knockout'; match_id: string; winner_id: string };

/**
 * Validates the organizer's match-result submission.
 *
 * Group matches need two scores (0–99, draws allowed); knockout matches need
 * the winner to be one of the two players. The `players` pair is optional —
 * when supplied, a winner outside the two is rejected instead of silently
 * corrupting the bracket.
 *
 * @param input The raw request body.
 * @param players The match's two registration ids (knockout, optional).
 * @returns The cleaned payload, or a message safe to show the organizer.
 */
export function validateAdminMatchResult(
  input: unknown,
  players?: { player_a_id: string | null; player_b_id: string | null },
): ValidationResult<ValidatedAdminMatchResult> {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Send the result as a JSON object.' };
  }

  const body = input as Record<string, unknown>;
  const kind = body.kind;
  const matchId = typeof body.match_id === 'string' ? body.match_id.trim() : '';

  if (!matchId) return { ok: false, error: 'Send the match id, e.g. {"match_id":"…"}.' };

  if (kind === 'group') {
    const scoreA = body.score_a;
    const scoreB = body.score_b;
    const validScore = (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99;
    if (!validScore(scoreA) || !validScore(scoreB)) {
      return { ok: false, error: 'Both scores are needed, whole numbers from 0 to 99.' };
    }
    return { ok: true, value: { kind, match_id: matchId, score_a: scoreA, score_b: scoreB } };
  }

  if (kind === 'knockout') {
    const winnerId = typeof body.winner_id === 'string' ? body.winner_id.trim() : '';
    if (!winnerId) {
      return { ok: false, error: 'Knockout matches need a winner — pick one of the two players.' };
    }
    if (players) {
      const ids = [players.player_a_id, players.player_b_id];
      if (!ids.includes(winnerId)) {
        return { ok: false, error: 'The winner must be one of the two players in this match.' };
      }
    }
    return { ok: true, value: { kind, match_id: matchId, winner_id: winnerId } };
  }

  return { ok: false, error: 'Send kind: "group" or "knockout".' };
}

/**
 * True when the organizer may set a result on a match in this state.
 *
 * Completed matches are immutable from the dashboard: a completed knockout
 * match has already moved its winner into the next round, and re-deciding it
 * here would corrupt the bracket.
 *
 * @param status The match's current status.
 */
export function canSetResult(status: MatchStatus): boolean {
  return status === 'pending' || status === 'disputed';
}
