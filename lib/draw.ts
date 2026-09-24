/**
 * MODULE 2 — the AUTOMATIC group draw (the writing half).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The draw used to be a manual step: the organizer had to remember to POST to
 * `/api/admin/draw-groups` after the last player paid. That is one forgotten
 * curl away from a full tournament that has no fixtures, so the draw now runs
 * by itself the moment the tournament fills up. It is triggered from three
 * places, and every one of them goes through `ensureGroupDraw()`:
 *
 *   1. the moment a Paystack payment is VERIFIED — the signed webhook
 *      (`app/api/paystack/webhook/route.ts`), the browser callback
 *      (`app/api/verify-payment/route.ts`) and the server-rendered callback page
 *      (`app/payment/verify/page.tsx`) all call `drawWhenTournamentIsFull()`,
 *   2. a fresh request for the homepage, which reconciles a tournament that is
 *      already full but still undrawn (one that filled up before this feature
 *      existed, or whose draw died half-way),
 *   3. the protected admin route, kept as the organizer's recovery fallback.
 *
 * The rules that decide WHEN a draw may run live in `lib/draw-rules.ts`, which
 * is pure and testable; this module does the database work.
 *
 * SAFE TO RUN ANY TIME, ANYWHERE, FROM SEVERAL REQUESTS AT ONCE
 * ------------------------------------------------------------
 * Paystack retries webhooks, the browser callback arrives beside them, and a
 * busy homepage produces overlapping requests. A duplicate draw would create a
 * second set of groups and 12 duplicated fixtures, so the guards live in the
 * database rather than in memory (Vercel runs many instances):
 *
 *  - A conditional `UPDATE tournaments SET status = 'groups_drawn'
 *    WHERE id = ... AND status = <the status we read>` is the lock. Postgres
 *    updates the row for exactly one of the racing requests; every other
 *    request sees zero rows and backs off with `in_progress`.
 *  - `groups` also has a unique index on `(tournament_id, group_name)`, so even
 *    a lock that somehow failed could not produce two Group A rows.
 *  - `ensureGroupDraw()` is idempotent: once the groups exist it returns
 *    `already_drawn` without writing anything.
 *  - Every failure inside the draw is rolled back (the half-drawn groups are
 *    deleted and the previous status restored), so the next attempt starts from
 *    a clean state instead of leaving a corrupt tournament behind.
 *
 * SERVER ONLY. This module reads phone numbers through `getPaidPlayers()` and
 * writes with the service-role key; never import it into a client component.
 * (The browser-side Paystack popup lives in `lib/paystack.ts` and deliberately
 * knows nothing about it, so no part of this can leak into a client bundle.)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GroupDraw } from '@/types';
import { isSupabaseConfigured, supabaseAdmin } from './supabase';
import { createGroups, generateGroupFixtures } from './groups';
import { getPaidPlayers } from './data';
import { DRAWN_STATUS, drawDecision, type DrawDecision } from './draw-rules';

/* ==========================================================================
 * The rules, re-exported
 * ========================================================================== */

/**
 * The pure rules — `drawDecision()` and the limits — live in their own module
 * so they can be tested without a database. They are re-exported here because
 * callers of the draw (the admin route, the pages) only ever import this file.
 */
export {
  DRAWN_STATUS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type DrawDecision,
} from './draw-rules';

/* ==========================================================================
 * Running the draw
 * ========================================================================== */

/** The step of the draw that failed (used for logs and friendly messages). */
export type DrawStep =
  | 'tournament'
  | 'groups'
  | 'members'
  | 'fixtures'
  | 'standings';

/** What `ensureGroupDraw()` did. */
export interface DrawOutcome {
  /** True only when THIS call created the groups. */
  drawn: boolean;
  /** The decision that was reached, or why the draw could not be attempted. */
  reason: DrawDecision | 'not_configured' | 'not_found' | 'in_progress' | 'error';
  /** The drawn groups with their fixtures (empty unless `drawn` is true). */
  groups: GroupDraw[];
  /** How many round-robin fixtures were created. */
  fixtures_created: number;
  /** Paid players found at the time of the attempt. */
  paid_players: number;
  /** The tournament's `max_players`. */
  max_players: number;
  /** Which step failed when `reason` is 'error'. */
  error_step?: DrawStep;
  /** Short technical detail for the server log — never shown to a player. */
  error_detail?: string;
}

/**
 * Draws inside one server instance are shared, so the burst of requests that a
 * full tournament produces (several tabs, the Paystack retry, the homepage)
 * waits for one draw instead of starting their own. The database lock in
 * `runDraw()` is what makes this safe across instances; this only saves work.
 */
const inFlight = new Map<string, Promise<DrawOutcome>>();

/**
 * Makes sure a tournament's groups exist once enough players have paid.
 *
 * This is the single entry point for the automatic draw and for the admin
 * fallback, and it is idempotent: calling it twice (or ten times, concurrently)
 * produces one set of groups and never a duplicate fixture.
 *
 * @param tournamentId The tournament's UUID.
 * @param options.requireFull Defaults to true — wait for `max_players` paid
 *        players. The admin route passes false to draw early by hand.
 * @param options.client An existing service-role client (optional), so a
 *        caller that already has one open does not open a second.
 * @returns A {@link DrawOutcome}; it never throws and never leaves a
 *          half-drawn tournament behind.
 *
 * @example
 * const outcome = await ensureGroupDraw(tournament.id);
 * if (outcome.drawn) console.log(outcome.fixtures_created, 'fixtures created');
 */
export async function ensureGroupDraw(
  tournamentId: string,
  options: { requireFull?: boolean; client?: SupabaseClient } = {},
): Promise<DrawOutcome> {
  if (!tournamentId) {
    return emptyOutcome('not_found');
  }

  if (!options.client && !isSupabaseConfigured()) {
    return emptyOutcome('not_configured');
  }

  const running = inFlight.get(tournamentId);
  if (running) return running;

  const attempt = runDraw(tournamentId, options).finally(() => {
    inFlight.delete(tournamentId);
  });

  inFlight.set(tournamentId, attempt);
  return attempt;
}

/**
 * Draws the groups if a tournament has just become full — the call payment
 * confirmation makes, and safe to make every single time.
 *
 * It exists so the three payment paths (webhook, callback route, callback page)
 * do not each need their own copy of the "never let a draw break a confirmed
 * payment" rule:
 *
 *  - it never throws, and it never reports anything to the player,
 *  - it does nothing at all unless the tournament is full and undrawn,
 *  - any failure is logged for the organizer and left to the next homepage
 *    request (or the admin route) to retry.
 *
 * @param tournamentId The tournament of the verified payment (may be missing).
 * @returns Nothing.
 *
 * @example
 * await drawWhenTournamentIsFull(result.tournament_id);
 */
export async function drawWhenTournamentIsFull(
  tournamentId?: string | null,
): Promise<void> {
  if (!tournamentId) return;

  try {
    const outcome = await ensureGroupDraw(tournamentId);

    if (outcome.drawn) {
      console.log(
        `[draw] tournament full — ${outcome.groups.length} groups and ${outcome.fixtures_created} fixtures created`,
      );
    } else if (outcome.reason === 'error') {
      console.error('[draw] automatic group draw failed', outcome.error_step);
    }
  } catch (error) {
    // Belt and braces: ensureGroupDraw() already catches its own failures, and
    // a confirmed payment must never fail because of the draw.
    console.error('[draw] automatic group draw crashed', error);
  }
}

/**
 * The real work: read, decide, lock, write, roll back on failure.
 *
 * @param tournamentId The tournament's UUID.
 * @param options See {@link ensureGroupDraw}.
 * @returns The outcome, including a friendly `reason` when nothing was done.
 */
async function runDraw(
  tournamentId: string,
  options: { requireFull?: boolean; client?: SupabaseClient },
): Promise<DrawOutcome> {
  const requireFull = options.requireFull ?? true;
  const supabase = options.client ?? supabaseAdmin();

  /** The status we found, so a failed attempt can put it back. */
  let previousStatus: string | null = null;
  /** The groups this attempt created — the only rows a rollback may delete. */
  let createdGroupIds: string[] = [];
  /** True once the conditional status update has given us the draw. */
  let claimed = false;

  /** Puts the tournament back exactly as it was found. */
  const rollback = async () => {
    if (createdGroupIds.length > 0) {
      const { error } = await supabase
        .from('groups')
        .delete()
        .in('id', createdGroupIds);
      if (error) {
        console.error('[draw.rollback] could not delete the half-drawn groups', error);
      }
      createdGroupIds = [];
    }

    if (claimed) {
      // Only release the lock we still hold.
      const { error } = await supabase
        .from('tournaments')
        .update({ status: previousStatus })
        .eq('id', tournamentId)
        .eq('status', DRAWN_STATUS);
      if (error) {
        console.error('[draw.rollback] could not restore the status', error);
      }
      claimed = false;
    }
  };

  /** Builds a failure outcome and rolls the attempt back first. */
  const fail = async (
    step: DrawStep,
    detail: unknown,
    paidPlayers = 0,
  ): Promise<DrawOutcome> => {
    console.error(`[draw.${step}]`, detail);
    await rollback();
    return {
      ...emptyOutcome('error'),
      error_step: step,
      error_detail: detail instanceof Error ? detail.message : String(detail),
      paid_players: paidPlayers,
    };
  };

  try {
    // --- 1. Read the tournament ------------------------------------------
    const { data: tournamentRow, error: tournamentError } = await supabase
      .from('tournaments')
      .select('id, title, status, max_players')
      .eq('id', tournamentId)
      .maybeSingle();

    if (tournamentError) {
      return fail('tournament', tournamentError);
    }

    if (!tournamentRow) {
      return emptyOutcome('not_found');
    }

    previousStatus = (tournamentRow.status as string | null) ?? null;
    const maxPlayers = Number(tournamentRow.max_players ?? 0);

    // --- 2. Is it already drawn? ------------------------------------------
    const { count: existingGroups, error: groupsCountError } = await supabase
      .from('groups')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId);

    if (groupsCountError) {
      return fail('tournament', groupsCountError);
    }

    // `getPaidPlayers` is given the client we already have, so the draw never
    // opens a second connection to the database.
    const players = await getPaidPlayers(tournamentId, supabase);
    const paidPlayers = players.length;

    const decision = drawDecision({
      status: previousStatus,
      existingGroups: existingGroups ?? 0,
      paidPlayers,
      maxPlayers,
      requireFull,
    });

    if (decision !== 'draw') {
      // An earlier attempt may have created the groups and then died before it
      // could move the tournament on. Put the status right — a drawn
      // tournament must not still look "open" to the register route.
      if ((existingGroups ?? 0) > 0) {
        await repairStatus(supabase, tournamentId, previousStatus);
      }

      return { ...emptyOutcome(decision), paid_players: paidPlayers, max_players: maxPlayers };
    }

    // --- 3. Lock the draw --------------------------------------------------
    // Exactly one racing request can change the row; the others get no rows
    // back and must not touch anything. Re-running after an interrupted
    // attempt is allowed, because the condition is the status we just read.
    const claim = supabase
      .from('tournaments')
      .update({ status: DRAWN_STATUS })
      .eq('id', tournamentId);

    const { data: claimedRows, error: claimError } = await (
      previousStatus === null
        ? claim.is('status', null)
        : claim.eq('status', previousStatus)
    ).select('id');

    if (claimError) {
      return fail('tournament', claimError, paidPlayers);
    }

    if (!claimedRows || claimedRows.length === 0) {
      // Someone else is drawing this tournament right now.
      return { ...emptyOutcome('in_progress'), paid_players: paidPlayers, max_players: maxPlayers };
    }

    claimed = true;

    // --- 4. Fair draw into groups of four ---------------------------------
    const drawn = createGroups(players);

    const { data: insertedGroups, error: groupError } = await supabase
      .from('groups')
      .insert(
        drawn.map((group) => ({
          tournament_id: tournamentId,
          group_name: group.group_name,
        })),
      )
      .select();

    if (groupError || !insertedGroups) {
      // Belt and braces: if the unique index on (tournament_id, group_name)
      // rejects the insert, another draw got there first — keep its groups and
      // leave its lock alone.
      if (isDuplicateKey(groupError)) {
        claimed = false;
        return { ...emptyOutcome('already_drawn'), paid_players: paidPlayers, max_players: maxPlayers };
      }
      return fail('groups', groupError, paidPlayers);
    }

    createdGroupIds = insertedGroups.map((row) => row.id as string);
    const groupIdByName = new Map<string, string>(
      insertedGroups.map((row) => [row.group_name as string, row.id as string]),
    );

    // --- 5. Group members --------------------------------------------------
    const memberRows = drawn.flatMap((group) =>
      group.players.map((player) => ({
        group_id: groupIdByName.get(group.group_name) as string,
        tournament_id: tournamentId,
        player_id: player.id,
      })),
    );

    const { error: memberError } = await supabase
      .from('group_members')
      .insert(memberRows);

    if (memberError) {
      return fail('members', memberError, paidPlayers);
    }

    // --- 6. Round-robin fixtures ------------------------------------------
    // `createGroups` returns public players (no phone numbers), so the fixtures
    // are generated from the full registration rows loaded above.
    const registrationById = new Map(players.map((player) => [player.id, player]));

    const fixtureRows = drawn.flatMap((group) => {
      const groupId = groupIdByName.get(group.group_name) as string;
      const groupPlayers = group.players
        .map((player) => registrationById.get(player.id))
        .filter((player): player is NonNullable<typeof player> => Boolean(player));

      // A group of 4 produces exactly 6 fixtures.
      return generateGroupFixtures(groupId, groupPlayers).map((fixture) => ({
        group_id: fixture.group_id,
        tournament_id: fixture.tournament_id,
        match_number: fixture.match_number,
        player_a_id: fixture.player_a_id,
        player_b_id: fixture.player_b_id,
        status: fixture.status,
      }));
    });

    const { data: insertedFixtures, error: fixtureError } = await supabase
      .from('group_matches')
      .insert(fixtureRows)
      .select();

    if (fixtureError || !insertedFixtures) {
      return fail('fixtures', fixtureError, paidPlayers);
    }

    // --- 7. Zeroed league tables ------------------------------------------
    const standingRows = memberRows.map((member) => ({
      group_id: member.group_id,
      tournament_id: tournamentId,
      player_id: member.player_id,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goals_for: 0,
      goals_against: 0,
      goal_difference: 0,
      points: 0,
    }));

    const { error: standingError } = await supabase
      .from('group_standings')
      .upsert(standingRows, { onConflict: 'group_id,player_id' });

    if (standingError) {
      return fail('standings', standingError, paidPlayers);
    }

    const fixturesByGroupId = new Map<string, typeof insertedFixtures>();
    insertedFixtures.forEach((fixture) => {
      const list = fixturesByGroupId.get(fixture.group_id as string) ?? [];
      list.push(fixture);
      fixturesByGroupId.set(fixture.group_id as string, list);
    });

    const groups: GroupDraw[] = drawn.map((group) => {
      const groupId = groupIdByName.get(group.group_name) as string;
      const rows = (fixturesByGroupId.get(groupId) ?? [])
        .slice()
        .sort((a, b) => (a.match_number as number) - (b.match_number as number));

      return {
        group_name: group.group_name,
        // `createGroups` already reduced players to safe display fields, so
        // phone numbers never leave the server.
        players: group.players,
        fixtures: rows.map((row) => ({
          id: row.id as string,
          group_id: row.group_id as string,
          tournament_id: row.tournament_id as string,
          match_number: row.match_number as number,
          player_a_id: row.player_a_id as string,
          player_b_id: row.player_b_id as string,
          player_a_score: (row.player_a_score as number | null) ?? null,
          player_b_score: (row.player_b_score as number | null) ?? null,
          player_a_screenshot: null,
          player_b_screenshot: null,
          winner_id: null,
          status: (row.status as 'pending') ?? 'pending',
          created_at: (row.created_at as string) ?? new Date().toISOString(),
        })),
      };
    });

    console.log(
      `[draw] ${tournamentRow.title as string}: ${groups.length} groups, ${fixtureRows.length} fixtures`,
    );

    return {
      drawn: true,
      reason: 'draw',
      groups,
      fixtures_created: fixtureRows.length,
      paid_players: paidPlayers,
      max_players: maxPlayers,
    };
  } catch (error) {
    return fail('tournament', error);
  }
}

/**
 * Moves a tournament on to `groups_drawn` when its groups exist but the status
 * was never updated (a draw interrupted between its two last writes).
 *
 * Only ever moves `open`/`closed` forward, so a knockout tournament can never
 * be pushed back to the group stage by this repair.
 *
 * @param supabase Service-role client.
 * @param tournamentId The tournament's UUID.
 * @param status The status that was read.
 * @returns Nothing; failures are logged, never thrown.
 */
async function repairStatus(
  supabase: SupabaseClient,
  tournamentId: string,
  status: string | null,
): Promise<void> {
  if (status !== 'open' && status !== 'closed') return;

  const { error } = await supabase
    .from('tournaments')
    .update({ status: DRAWN_STATUS })
    .eq('id', tournamentId)
    .eq('status', status);

  if (error) {
    console.error('[draw.repairStatus]', error);
  }
}

/**
 * True when a Supabase error is Postgres' unique-violation (`23505`).
 *
 * @param error The error returned by Supabase (may be null).
 * @returns True for a duplicate-key error.
 */
function isDuplicateKey(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '23505' || /duplicate key/i.test(error.message ?? '');
}

/**
 * A blank outcome, so every early return has the same shape.
 *
 * @param reason Why nothing was (or could be) drawn.
 * @returns An outcome with no groups.
 */
function emptyOutcome(reason: DrawOutcome['reason']): DrawOutcome {
  return {
    drawn: false,
    reason,
    groups: [],
    fixtures_created: 0,
    paid_players: 0,
    max_players: 0,
  };
}
