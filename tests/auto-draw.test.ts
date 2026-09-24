/**
 * Rules of the AUTOMATIC group draw.
 *
 * `lib/draw-rules.ts` holds the decisions (pure — no database), and the draw
 * itself is `createGroups()`/`generateGroupFixtures()` from `lib/groups.ts`.
 * These are the checks that stand between a correct draw and duplicated
 * fixtures: when it runs, when it must do nothing, and what a full 8-player
 * tournament is supposed to produce (2 groups, 12 fixtures).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Registration } from '../types';
import { drawDecision, groupsForPlayerCount, isSupportedPlayerCount, MAX_PLAYERS, MIN_PLAYERS } from '../lib/draw-rules';
import { createGroups, generateGroupFixtures } from '../lib/groups';

/** A full tournament, nothing drawn yet — the live "DLS Champions Cup #1" case. */
const FULL_OPEN = {
  status: 'open',
  existingGroups: 0,
  paidPlayers: 8,
  maxPlayers: 8,
};

test('draws as soon as the last paid registration reaches max_players', () => {
  assert.equal(drawDecision(FULL_OPEN), 'draw');
  // 16 players → 4 groups, a supported shape (9–12 would be 3 groups and is
  // refused — see the format-limit tests at the bottom of this file).
  assert.equal(drawDecision({ ...FULL_OPEN, paidPlayers: 16, maxPlayers: 16 }), 'draw');
});

test('does not draw while a slot is still unpaid', () => {
  assert.equal(drawDecision({ ...FULL_OPEN, paidPlayers: 7 }), 'not_full');
  // A pending (unpaid) registration does not count — only verified payments do.
  assert.equal(drawDecision({ ...FULL_OPEN, paidPlayers: MIN_PLAYERS }), 'not_full');
});

test('a duplicate Paystack event can never draw twice', () => {
  // Second delivery of the same webhook, and the browser callback beside it:
  // the groups exist, so the decision is a no-op whatever the status says.
  assert.equal(
    drawDecision({ ...FULL_OPEN, status: 'groups_drawn', existingGroups: 2 }),
    'already_drawn',
  );
  assert.equal(drawDecision({ ...FULL_OPEN, existingGroups: 2 }), 'already_drawn');
  // Same for a homepage request arriving after the draw.
  assert.equal(
    drawDecision({ ...FULL_OPEN, status: 'bracket_drawn', existingGroups: 2 }),
    'already_drawn',
  );
  assert.equal(
    drawDecision({ ...FULL_OPEN, status: 'completed', existingGroups: 2 }),
    'already_drawn',
  );
});

test('an interrupted attempt is retryable, a knockout tournament is not', () => {
  // The status was flipped before the groups could be written (the process
  // died) — no groups means the draw still has to happen.
  assert.equal(drawDecision({ ...FULL_OPEN, status: 'groups_drawn' }), 'draw');
  // A knockout tournament is finished business, groups or no groups.
  assert.equal(drawDecision({ ...FULL_OPEN, status: 'bracket_drawn' }), 'already_drawn');
  assert.equal(drawDecision({ ...FULL_OPEN, status: 'completed' }), 'already_drawn');
});

test('respects the format limits', () => {
  assert.equal(drawDecision({ ...FULL_OPEN, paidPlayers: 5, maxPlayers: 5 }), 'not_enough_players');
  assert.equal(
    drawDecision({ ...FULL_OPEN, paidPlayers: MAX_PLAYERS + 1, maxPlayers: MAX_PLAYERS + 1 }),
    'too_many_players',
  );
});

test('the admin fallback may draw before the tournament is full', () => {
  assert.equal(
    drawDecision({ ...FULL_OPEN, paidPlayers: MIN_PLAYERS, requireFull: false }),
    'draw',
  );
  // …but not below the minimum, and not twice.
  assert.equal(
    drawDecision({ ...FULL_OPEN, paidPlayers: MIN_PLAYERS - 1, requireFull: false }),
    'not_enough_players',
  );
  assert.equal(
    drawDecision({ ...FULL_OPEN, existingGroups: 2, requireFull: false }),
    'already_drawn',
  );
});

/* ==========================================================================
 * What a full 8-player tournament produces — the live expectations
 * ========================================================================== */

/** Builds the fields `createGroups()`/`generateGroupFixtures()` actually read. */
function player(index: number): Registration {
  return {
    id: `player-${index}`,
    tournament_id: 'tournament-1',
    player_name: `Player ${index}`,
    phone_number: `02400000${String(index).padStart(2, '0')}`,
    momo_number: `02400000${String(index).padStart(2, '0')}`,
    dls_team_name: `Team ${index}`,
    paystack_reference: `DLS-REF-${index}`,
    payment_status: 'paid',
    created_at: new Date(0).toISOString(),
  };
}

test('8 paid players produce 2 groups of 4 with 12 fixtures', () => {
  const players = Array.from({ length: 8 }, (_, index) => player(index + 1));
  const groups = createGroups(players);

  assert.deepEqual(
    groups.map((group) => group.group_name),
    ['A', 'B'],
  );
  assert.deepEqual(
    groups.map((group) => group.players.length),
    [4, 4],
  );

  // Every player appears exactly once across the draw.
  const drawnIds = groups.flatMap((group) => group.players.map((p) => p.id));
  assert.equal(new Set(drawnIds).size, 8);

  const fixtures = groups.flatMap((group) => {
    const groupId = `group-${group.group_name}`;
    const registrations = group.players.map((publicPlayer) =>
      players.find((candidate) => candidate.id === publicPlayer.id)!,
    );
    return generateGroupFixtures(groupId, registrations);
  });

  assert.equal(fixtures.length, 12);

  // Each group is a complete round robin: 6 fixtures, no repeated pairing.
  for (const group of groups) {
    const groupFixtures = fixtures.filter(
      (fixture) => fixture.group_id === `group-${group.group_name}`,
    );
    assert.equal(groupFixtures.length, 6);

    const pairings = new Set(
      groupFixtures.map((fixture) =>
        [fixture.player_a_id, fixture.player_b_id].sort().join('|'),
      ),
    );
    assert.equal(pairings.size, 6);
    assert.ok(
      groupFixtures.every(
        (fixture) =>
          fixture.match_number >= 1 &&
          fixture.match_number <= 6 &&
          fixture.status === 'pending' &&
          fixture.tournament_id === 'tournament-1',
      ),
    );
  }

  // Phone numbers must never reach a browser.
  assert.ok(groups.every((group) => group.players.every((p) => !('phone_number' in p))));
});

/* ==========================================================================
 * The draw itself, against an in-memory database
 * ========================================================================== */

/**
 * These run `ensureGroupDraw()` for real, against the fake Supabase client in
 * `tests/fake-supabase.ts`. They answer the questions the live tournament raises
 * — did the full tournament get drawn, and did anything get drawn twice?
 */

import { ensureGroupDraw } from '../lib/draw';
import { createFakeDb, createFakeSupabase } from './fake-supabase';

/** Row counts, so a test can prove nothing extra was written. */
function counts(db: ReturnType<typeof createFakeDb>) {
  const { tables } = db;
  return {
    groups: tables.groups.length,
    members: tables.group_members.length,
    fixtures: tables.group_matches.length,
    standings: tables.group_standings.length,
    status: tables.tournaments[0].status,
  };
}

test('a full tournament is drawn automatically: 2 groups, 12 fixtures', async () => {
  const db = createFakeDb({ paidCount: 8 });
  const outcome = await ensureGroupDraw('tournament-1', {
    client: createFakeSupabase(db),
  });

  assert.equal(outcome.drawn, true);
  assert.equal(outcome.reason, 'draw');
  assert.equal(outcome.groups.length, 2);
  assert.equal(outcome.fixtures_created, 12);
  assert.deepEqual(
    outcome.groups.map((group) => group.group_name),
    ['A', 'B'],
  );

  const written = counts(db);
  assert.equal(written.groups, 2);
  assert.equal(written.members, 8);
  assert.equal(written.fixtures, 12);
  assert.equal(written.standings, 8);
  assert.equal(written.status, 'groups_drawn');

  // Every fixture came back with a real id and nobody is left out.
  const fixtureIds = outcome.groups.flatMap((group) =>
    group.fixtures.map((fixture) => fixture.id),
  );
  assert.equal(new Set(fixtureIds).size, 12);
});

test('a duplicate Paystack callback or webhook writes nothing at all', async () => {
  const db = createFakeDb({ paidCount: 8 });
  const client = createFakeSupabase(db);

  const first = await ensureGroupDraw('tournament-1', { client });
  assert.equal(first.drawn, true);
  const afterFirst = counts(db);

  // The webhook retried, the browser callback arrived, and the homepage was
  // opened twice — at the same time as each other and after the fact.
  const [retry, callback] = await Promise.all([
    ensureGroupDraw('tournament-1', { client }),
    ensureGroupDraw('tournament-1', { client }),
  ]);
  const afterRetries = await ensureGroupDraw('tournament-1', { client });

  for (const outcome of [retry, callback, afterRetries]) {
    assert.equal(outcome.drawn, false);
    assert.equal(outcome.reason, 'already_drawn');
    assert.equal(outcome.groups.length, 0);
  }

  // One set of groups and exactly 12 fixtures — never 24.
  assert.deepEqual(counts(db), afterFirst);
});

test('a tournament that filled up earlier is drawn on the next request', async () => {
  // The live case: 8/8 paid and the draw never ran (the feature did not exist).
  const db = createFakeDb({ paidCount: 8, status: 'closed' });
  const outcome = await ensureGroupDraw('tournament-1', {
    client: createFakeSupabase(db),
  });

  assert.equal(outcome.drawn, true);
  assert.equal(outcome.fixtures_created, 12);
  assert.equal(counts(db).status, 'groups_drawn');
});

test('an interrupted attempt is finished by the next one', async () => {
  // The lock was taken but the process died before the groups were written.
  const db = createFakeDb({ paidCount: 8, status: 'groups_drawn' });
  const outcome = await ensureGroupDraw('tournament-1', {
    client: createFakeSupabase(db),
  });

  assert.equal(outcome.drawn, true);
  assert.equal(counts(db).fixtures, 12);
});

test('a racing draw backs off instead of creating a second set of fixtures', async () => {
  const db = createFakeDb({ paidCount: 8 });

  // Another serverless instance wins the lock a moment before ours tries to
  // claim it: the tournament status changes and its groups appear.
  db.beforeQuery = (table, operation) => {
    if (table === 'tournaments' && operation === 'update') {
      db.tables.tournaments[0].status = 'groups_drawn';
      db.tables.groups.push(
        { id: 'other-a', tournament_id: 'tournament-1', group_name: 'A' },
        { id: 'other-b', tournament_id: 'tournament-1', group_name: 'B' },
      );
      db.beforeQuery = undefined;
    }
  };

  const outcome = await ensureGroupDraw('tournament-1', {
    client: createFakeSupabase(db),
  });

  assert.equal(outcome.drawn, false);
  assert.equal(outcome.reason, 'in_progress');
  // The other instance's groups are untouched and no fixtures were added here.
  assert.equal(db.tables.groups.length, 2);
  assert.equal(db.tables.group_matches.length, 0);
});

test('a failed step rolls the draw back instead of leaving half a tournament', async () => {
  const db = createFakeDb({ paidCount: 8 });
  db.failInsertOn = 'group_matches';

  const outcome = await ensureGroupDraw('tournament-1', {
    client: createFakeSupabase(db),
  });

  assert.equal(outcome.drawn, false);
  assert.equal(outcome.reason, 'error');
  assert.equal(outcome.error_step, 'fixtures');

  // Everything the attempt wrote is gone, and the tournament is open again for
  // the homepage (or the admin route) to retry.
  const written = counts(db);
  assert.equal(written.groups, 0);
  assert.equal(written.members, 0);
  assert.equal(written.fixtures, 0);
  assert.equal(written.standings, 0);
  assert.equal(written.status, 'open');
});

test('a tournament that is not full yet is left alone by the automatic draw', async () => {
  const db = createFakeDb({ paidCount: 7 });
  const outcome = await ensureGroupDraw('tournament-1', {
    client: createFakeSupabase(db),
  });

  assert.equal(outcome.drawn, false);
  assert.equal(outcome.reason, 'not_full');
  assert.equal(counts(db).groups, 0);
  assert.equal(counts(db).status, 'open');
});

/* ==========================================================================
 * Format limits — the knockout stage needs 2 or 4 groups (review finding #2)
 * ========================================================================== */

test('9–12 paid players are refused: 3 groups cannot be bracketed', () => {
  for (const paid of [9, 10, 11, 12]) {
    assert.equal(
      drawDecision({ ...FULL_OPEN, paidPlayers: paid, maxPlayers: paid }),
      'unsupported_format',
      `${paid} players must not draw`,
    );
  }
});

test('6–8 and 13–16 paid players draw: 2 or 4 groups', () => {
  for (const paid of [6, 7, 8]) {
    assert.equal(
      drawDecision({ ...FULL_OPEN, paidPlayers: paid, maxPlayers: paid }),
      'draw',
      `${paid} players must draw (2 groups)`,
    );
  }
  for (const paid of [13, 14, 15, 16]) {
    assert.equal(
      drawDecision({ ...FULL_OPEN, paidPlayers: paid, maxPlayers: paid }),
      'draw',
      `${paid} players must draw (4 groups)`,
    );
  }
});

test('isSupportedPlayerCount matches the draw decision', () => {
  for (const n of [0, 1, 5, 9, 10, 11, 12, 17, 20]) {
    assert.equal(isSupportedPlayerCount(n), false, `${n} must be unsupported`);
  }
  for (const n of [6, 7, 8, 13, 14, 15, 16]) {
    assert.equal(isSupportedPlayerCount(n), true, `${n} must be supported`);
  }
  // 5 players would be 2 groups but sit below the tournament minimum.
  assert.equal(groupsForPlayerCount(5), 2);
  assert.equal(groupsForPlayerCount(9), 3);
  assert.equal(groupsForPlayerCount(12), 3);
  assert.equal(groupsForPlayerCount(13), 4);
});
