/**
 * Player-perspective view helpers (lib/player-view.ts).
 *
 * The My Matches page is built entirely from these: scores from the player's
 * side, confirmed outcomes, and the submitted-proof flags.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bracket, GroupMatch } from '../types';
import {
  confirmedOutcome,
  ordinal,
  playerGroupFixtureView,
  playerKnockoutFixtureView,
} from '../lib/player-view';

const ME = 'me-1';
const OPPONENT = 'opp-2';

function groupMatch(overrides: Partial<GroupMatch> = {}): GroupMatch {
  return {
    id: 'm1',
    group_id: 'g1',
    tournament_id: 't1',
    match_number: 1,
    player_a_id: ME,
    player_b_id: OPPONENT,
    player_a_score: null,
    player_b_score: null,
    player_a_screenshot: null,
    player_b_screenshot: null,
    winner_id: null,
    status: 'pending',
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

test('group fixture: scores are shown from the viewer perspective', () => {
  // I am player A: my 2, theirs 1.
  const asA = playerGroupFixtureView(
    groupMatch({
      player_a_score: 2,
      player_b_score: 1,
      status: 'completed',
      winner_id: ME,
    }),
    ME,
    { [OPPONENT]: 'Ama', [ME]: 'Kofi' },
    { [OPPONENT]: 'Team Ama' },
  );

  assert.ok(asA);
  assert.equal(asA.opponent_name, 'Ama');
  assert.equal(asA.opponent_team, 'Team Ama');
  assert.equal(asA.my_score, 2);
  assert.equal(asA.opponent_score, 1);
  assert.equal(asA.outcome, 'won');

  // The same fixture from player B's side: my 1, theirs 2, and I lost.
  const asB = playerGroupFixtureView(
    groupMatch({
      player_a_id: ME,
      player_b_id: OPPONENT,
      player_a_score: 2,
      player_b_score: 1,
      status: 'completed',
      winner_id: ME,
    }),
    OPPONENT,
    { [ME]: 'Kofi' },
  );

  assert.ok(asB);
  assert.equal(asB.opponent_name, 'Kofi');
  assert.equal(asB.my_score, 1);
  assert.equal(asB.opponent_score, 2);
  assert.equal(asB.outcome, 'lost');
});

test('group fixture: draws, submissions flags, and non-participants', () => {
  const draw = playerGroupFixtureView(
    groupMatch({
      player_a_score: 1,
      player_b_score: 1,
      status: 'completed',
      winner_id: null,
      player_a_screenshot: 'https://x.test/a.jpg',
    }),
    ME,
    { [OPPONENT]: 'Ama' },
  );
  assert.ok(draw);
  assert.equal(draw.outcome, 'draw');
  assert.equal(draw.i_submitted, true);
  assert.equal(draw.opponent_submitted, false);

  // Not my match → nothing to show.
  assert.equal(
    playerGroupFixtureView(groupMatch(), 'someone-else', {}),
    null,
  );
});

function bracketMatch(overrides: Partial<Bracket> = {}): Bracket {
  return {
    id: 'b1',
    tournament_id: 't1',
    round: 1,
    match_number: 1,
    player_a_id: ME,
    player_b_id: OPPONENT,
    winner_id: null,
    player_a_screenshot: null,
    player_b_screenshot: null,
    status: 'pending',
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

test('knockout fixture: perspective outcome and round label carry through', () => {
  const won = playerKnockoutFixtureView(
    bracketMatch({ status: 'completed', winner_id: ME }),
    ME,
    'Ama',
    'Team Ama',
    'Semifinal 1',
  );
  assert.ok(won);
  assert.equal(won.round_label, 'Semifinal 1');
  assert.equal(won.outcome, 'won');
  assert.equal(won.match_number, null);

  const lost = playerKnockoutFixtureView(
    bracketMatch({
      player_a_id: ME,
      player_b_id: OPPONENT,
      status: 'completed',
      winner_id: ME,
    }),
    OPPONENT,
    'Kofi',
    null,
    'Semifinal 1',
  );
  assert.ok(lost);
  assert.equal(lost.outcome, 'lost');

  assert.equal(
    playerKnockoutFixtureView(bracketMatch(), 'someone-else', 'x', null, 'R'),
    null,
  );
});

test('outcomes are null until the match is completed', () => {
  assert.equal(confirmedOutcome('pending', ME, ME), null);
  assert.equal(confirmedOutcome('disputed', ME, ME), null);
  assert.equal(confirmedOutcome('completed', ME, ME), 'won');
  assert.equal(confirmedOutcome('completed', OPPONENT, ME), 'lost');
  assert.equal(confirmedOutcome('completed', null, ME), 'draw');
});

test('ordinals: 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 22nd', () => {
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(4), '4th');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(13), '13th');
  assert.equal(ordinal(21), '21st');
  assert.equal(ordinal(22), '22nd');
});
