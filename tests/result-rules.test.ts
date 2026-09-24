/**
 * Result-confirmation rules (lib/result-rules.ts) — the agree/dispute engine.
 *
 * This is the logic both players' submissions flow through, so it gets the
 * exact scenarios an organizer would have to arbitrate: agreement (including
 * a draw), conflict, and the knockout "who won?" comparison.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareGroupClaims,
  completedGroupMatch,
  groupWinnerId,
  resolveKnockoutClaims,
} from '../lib/result-rules';
import type { GroupMatch } from '../types';

const PLAYER_A = 'aaaa-1';
const PLAYER_B = 'bbbb-2';

test('matching group claims confirm; equal scores confirm as a draw', () => {
  assert.equal(compareGroupClaims(3, 1, 3, 1), 'confirm');
  assert.equal(compareGroupClaims(2, 2, 2, 2), 'confirm');
});

test('conflicting group claims dispute — in both directions of a mismatch', () => {
  assert.equal(compareGroupClaims(3, 1, 1, 3), 'dispute');
  assert.equal(compareGroupClaims(2, 1, 2, 0), 'dispute');
});

test('a missing stored claim can never agree', () => {
  assert.equal(compareGroupClaims(0, 0, null, null), 'dispute');
  assert.equal(compareGroupClaims(1, 0, null, 0), 'dispute');
});

test('group winner: higher score wins, level scores have no winner', () => {
  assert.equal(groupWinnerId(3, 1, PLAYER_A, PLAYER_B), PLAYER_A);
  assert.equal(groupWinnerId(0, 2, PLAYER_A, PLAYER_B), PLAYER_B);
  assert.equal(groupWinnerId(1, 1, PLAYER_A, PLAYER_B), null);
  assert.equal(groupWinnerId(0, 0, PLAYER_A, PLAYER_B), null);
});

test('knockout claims agree only when both name the same winner', () => {
  assert.deepEqual(resolveKnockoutClaims(PLAYER_A, PLAYER_A), {
    agreed: true,
    winner_id: PLAYER_A,
  });
  assert.deepEqual(resolveKnockoutClaims(PLAYER_B, PLAYER_B), {
    agreed: true,
    winner_id: PLAYER_B,
  });
  assert.deepEqual(resolveKnockoutClaims(PLAYER_A, PLAYER_B), {
    agreed: false,
    winner_id: null,
  });
});

test('knockout claims with a missing side stay undecided, never auto-confirm', () => {
  assert.deepEqual(resolveKnockoutClaims(null, PLAYER_A), {
    agreed: false,
    winner_id: null,
  });
  assert.deepEqual(resolveKnockoutClaims(PLAYER_A, null), {
    agreed: false,
    winner_id: null,
  });
});

test('completedGroupMatch builds the row updateStandings() expects', () => {
  const pending = {
    id: 'm1',
    group_id: 'g1',
    tournament_id: 't1',
    match_number: 1,
    player_a_id: PLAYER_A,
    player_b_id: PLAYER_B,
    player_a_score: null,
    player_b_score: null,
    player_a_screenshot: null,
    player_b_screenshot: null,
    winner_id: null,
    status: 'pending',
    created_at: new Date(0).toISOString(),
  } as GroupMatch;

  const completed = completedGroupMatch(pending, 4, 2);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.player_a_score, 4);
  assert.equal(completed.player_b_score, 2);
  // The original row is not mutated.
  assert.equal(pending.status, 'pending');
  assert.equal(pending.player_a_score, null);
});
