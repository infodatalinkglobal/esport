/**
 * Pure knockout-bracket maths (lib/bracket.ts).
 *
 * These are the checks that keep the knockout stage honest: the group crossing
 * (nobody meets their own group in round one), the bracket shape for the two
 * supported formats, slot advancement, and champion detection.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bracket, GroupQualifier } from '../types';
import {
  createKnockoutBracket,
  findChampionId,
  knockoutMatchLabel,
  knockoutRoundCount,
  knockoutRoundLabel,
  nextRoundSlot,
  pairFirstKnockoutRound,
} from '../lib/bracket';

/** Builds a qualifier entry for a group/position pair. */
function qualifier(groupName: string, position: number): GroupQualifier {
  return {
    group_name: groupName,
    position,
    player: {
      id: `${groupName}${position}`,
      tournament_id: 'tournament-1',
      player_name: `Player ${groupName}${position}`,
      phone_number: `024000000${position}`,
      momo_number: `024000000${position}`,
      dls_team_name: `Team ${groupName}${position}`,
      paystack_reference: `DLS-REF-${groupName}${position}`,
      payment_status: 'paid',
      created_at: new Date(0).toISOString(),
    },
  };
}

function qualifiersFor(groupNames: string[]): GroupQualifier[] {
  return groupNames.flatMap((name) => [
    qualifier(name, 1),
    qualifier(name, 2),
  ]);
}

test('two groups cross as A1 v B2 and B1 v A2 (the 8-player format)', () => {
  const pairings = pairFirstKnockoutRound(qualifiersFor(['A', 'B']));

  assert.equal(pairings.length, 2);
  assert.deepEqual(
    pairings.map(({ playerA, playerB }) => `${playerA.player.id} v ${playerB.player.id}`),
    ['A1 v B2', 'B1 v A2'],
  );
});

test('four groups cross as (A,B) then (C,D) (the 16-player format)', () => {
  const pairings = pairFirstKnockoutRound(qualifiersFor(['A', 'B', 'C', 'D']));

  assert.equal(pairings.length, 4);
  assert.deepEqual(
    pairings.map(({ playerA, playerB }) => `${playerA.player.id} v ${playerB.player.id}`),
    ['A1 v B2', 'B1 v A2', 'C1 v D2', 'D1 v C2'],
  );
});

test('odd numbers of groups cannot silently strand a group', () => {
  // With THREE groups the pairing only covers complete pairs (A,B) — group C
  // would be dropped, which is exactly why the draw refuses 9–12-player
  // tournaments (drawDecision → 'unsupported_format'). The pairing function
  // still skips the incomplete pair rather than building a broken match.
  const pairings = pairFirstKnockoutRound(qualifiersFor(['A', 'B', 'C']));
  assert.equal(pairings.length, 2);
  const playing = new Set(
    pairings.flatMap(({ playerA, playerB }) => [playerA.player.id, playerB.player.id]),
  );
  assert.equal(playing.has('C1'), false);
  assert.equal(playing.has('C2'), false);
});

test('4 qualifiers → 2 rounds; 8 qualifiers → 3 rounds', () => {
  assert.equal(knockoutRoundCount(4), 2);
  assert.equal(knockoutRoundCount(8), 3);
  assert.equal(knockoutRoundCount(2), 1);
});

test('round labels: Quarterfinal, Semifinal, Grand Final', () => {
  assert.equal(knockoutRoundLabel(3, 3), 'Grand Final');
  assert.equal(knockoutRoundLabel(2, 3), 'Semifinal');
  assert.equal(knockoutRoundLabel(1, 3), 'Quarterfinal');
  assert.equal(knockoutMatchLabel(1, 2, 3), 'Quarterfinal 2');
  assert.equal(knockoutMatchLabel(3, 1, 3), 'Grand Final');
});

test('match winners advance into paired slots (1&2 → next match slot A/B)', () => {
  assert.deepEqual(nextRoundSlot({ round: 1, match_number: 1 }), {
    round: 2,
    match_number: 1,
    slot: 'a',
  });
  assert.deepEqual(nextRoundSlot({ round: 1, match_number: 2 }), {
    round: 2,
    match_number: 1,
    slot: 'b',
  });
  assert.deepEqual(nextRoundSlot({ round: 1, match_number: 3 }), {
    round: 2,
    match_number: 2,
    slot: 'a',
  });
  assert.deepEqual(nextRoundSlot({ round: 2, match_number: 2 }), {
    round: 3,
    match_number: 1,
    slot: 'b',
  });
});

test('the bracket is built to the final: round 1 real, later rounds placeholders', () => {
  const rows = createKnockoutBracket(qualifiersFor(['A', 'B']));

  // Semifinal 1, Semifinal 2, Grand Final placeholder.
  assert.deepEqual(
    rows.map((row) => `${row.round}/${row.match_number}`),
    ['1/1', '1/2', '2/1'],
  );
  assert.equal(rows[0].player_a_id, 'A1');
  assert.equal(rows[0].player_b_id, 'B2');
  assert.equal(rows[1].player_a_id, 'B1');
  assert.equal(rows[1].player_b_id, 'A2');
  assert.equal(rows[2].player_a_id, null);
  assert.equal(rows[2].player_b_id, null);
});

test('a 16-player bracket has quarterfinals, semifinals and a final', () => {
  const rows = createKnockoutBracket(qualifiersFor(['A', 'B', 'C', 'D']));

  assert.deepEqual(
    rows.map((row) => `${row.round}/${row.match_number}`),
    ['1/1', '1/2', '1/3', '1/4', '2/1', '2/2', '3/1'],
  );
});

function bracketRow(overrides: Partial<Bracket>): Bracket {
  return {
    id: overrides.round + '/' + overrides.match_number,
    tournament_id: 'tournament-1',
    round: 1,
    match_number: 1,
    player_a_id: null,
    player_b_id: null,
    winner_id: null,
    player_a_screenshot: null,
    player_b_screenshot: null,
    status: 'pending',
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

test('the champion is the completed final-round winner, nobody before that', () => {
  const undecided: Bracket[] = [
    bracketRow({ round: 1, match_number: 1, status: 'completed', winner_id: 'p1' }),
    bracketRow({ round: 1, match_number: 2, status: 'pending' }),
    bracketRow({ round: 2, match_number: 1, status: 'pending' }),
  ];
  assert.equal(findChampionId(undecided), null);

  const decided: Bracket[] = [
    bracketRow({ round: 1, match_number: 1, status: 'completed', winner_id: 'p1' }),
    bracketRow({ round: 1, match_number: 2, status: 'completed', winner_id: 'p1' }),
    bracketRow({ round: 2, match_number: 1, status: 'completed', winner_id: 'p1' }),
  ];
  assert.equal(findChampionId(decided), 'p1');
});
