/**
 * Tests for the admin dashboard's pure rules (MODULE 4).
 *
 * Everything here runs without a database: the questions the dashboard asks —
 * "what are the stats?", "which buttons may I press?", "is this input
 * valid?", "may this status change?" — are answered by `lib/admin-rules.ts`
 * as pure functions, exactly like the draw and result rules are.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALLOWED_STATUS_TRANSITIONS,
  adminActionAvailability,
  canChangeStatus,
  canSetResult,
  countMatches,
  countPayments,
  validateAdminMatchResult,
  validateTournamentInput,
} from '../lib/admin-rules';
import type { Tournament, TournamentStatus } from '../types';

/* ---------------------------------------------------------------- helpers */

/** A tournament row with overridable fields. */
function tournament(overrides: Partial<Tournament> = {}): Tournament {
  return {
    id: 't-1',
    title: 'DLS Champions Cup #1',
    entry_fee: 1000,
    max_players: 8,
    registration_deadline: new Date(Date.now() + 7 * 864e5).toISOString(),
    match_deadline: new Date(Date.now() + 14 * 864e5).toISOString(),
    status: 'open',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** The availability inputs for a tournament with overridable counts. */
function inputs(overrides: {
  status?: TournamentStatus;
  paid?: number;
  pending?: number;
  group?: { total?: number; pending?: number; completed?: number; disputed?: number };
  knockout?: { total?: number; pending?: number; completed?: number; disputed?: number };
}) {
  return {
    tournament: tournament(
      overrides.status ? { status: overrides.status } : undefined,
    ),
    payment_counts: { paid: overrides.paid ?? 0, pending: overrides.pending ?? 0 },
    group_matches: {
      total: overrides.group?.total ?? 0,
      pending: overrides.group?.pending ?? 0,
      completed: overrides.group?.completed ?? 0,
      disputed: overrides.group?.disputed ?? 0,
    },
    knockout_matches: {
      total: overrides.knockout?.total ?? 0,
      pending: overrides.knockout?.pending ?? 0,
      completed: overrides.knockout?.completed ?? 0,
      disputed: overrides.knockout?.disputed ?? 0,
    },
  };
}

/** A valid create payload with overridable fields. */
function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'DLS Champions Cup #2',
    entry_fee: 1000,
    max_players: 8,
    registration_deadline: new Date(Date.now() + 7 * 864e5).toISOString(),
    match_deadline: new Date(Date.now() + 14 * 864e5).toISOString(),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ counts */

test('countPayments tallies paid, pending and failed rows', () => {
  const counts = countPayments([
    { payment_status: 'paid' },
    { payment_status: 'paid' },
    { payment_status: 'pending' },
    { payment_status: 'failed' },
    { payment_status: 'paid' },
  ]);
  assert.deepEqual(counts, { paid: 3, pending: 1, failed: 1 });
});

test('countMatches tallies the three match statuses and the total', () => {
  const counts = countMatches([
    { status: 'pending' },
    { status: 'completed' },
    { status: 'completed' },
    { status: 'disputed' },
  ]);
  assert.deepEqual(counts, { total: 4, pending: 1, completed: 2, disputed: 1 });
});

/* --------------------------------------------------------------- lifecycle */

test('an open tournament with enough players can draw groups', () => {
  const actions = adminActionAvailability(inputs({ status: 'open', paid: 7 }));
  assert.equal(actions.draw_groups.allowed, true);
  assert.equal(actions.close_registration.allowed, true);
  assert.equal(actions.reopen_registration.allowed, false);
});

test('the group draw is blocked until MIN_PLAYERS have paid', () => {
  const actions = adminActionAvailability(inputs({ status: 'open', paid: 5 }));
  assert.equal(actions.draw_groups.allowed, false);
  assert.match(actions.draw_groups.reason, /at least 6/i);
});

test('a closed tournament can reopen but an open one cannot', () => {
  const closed = adminActionAvailability(inputs({ status: 'closed', paid: 6 }));
  assert.equal(closed.reopen_registration.allowed, true);
  assert.equal(closed.close_registration.allowed, false);

  const open = adminActionAvailability(inputs({ status: 'open', paid: 6 }));
  assert.equal(open.reopen_registration.allowed, false);
});

test('the knockout draw waits for every group result', () => {
  const unfinished = adminActionAvailability(
    inputs({ status: 'groups_drawn', group: { total: 6, pending: 2, completed: 4 } }),
  );
  assert.equal(unfinished.draw_knockout.allowed, false);
  assert.match(unfinished.draw_knockout.reason, /2 group fixture/);

  const ready = adminActionAvailability(
    inputs({ status: 'groups_drawn', group: { total: 6, completed: 6 } }),
  );
  assert.equal(ready.draw_knockout.allowed, true);
});

test('a disputed group match also blocks the knockout draw', () => {
  const actions = adminActionAvailability(
    inputs({ status: 'groups_drawn', group: { total: 6, completed: 5, disputed: 1 } }),
  );
  assert.equal(actions.draw_knockout.allowed, false);
});

test('the group stage can only be reset while it is the current stage', () => {
  const drawn = adminActionAvailability(inputs({ status: 'groups_drawn' }));
  assert.equal(drawn.reset_group_stage.allowed, true);

  const bracket = adminActionAvailability(inputs({ status: 'bracket_drawn' }));
  assert.equal(bracket.reset_group_stage.allowed, false);

  const open = adminActionAvailability(inputs({ status: 'open' }));
  assert.equal(open.reset_group_stage.allowed, false);
});

test('resetting a played group stage warns about the results it destroys', () => {
  const actions = adminActionAvailability(
    inputs({ status: 'groups_drawn', group: { total: 6, completed: 4, disputed: 1 } }),
  );
  assert.equal(actions.reset_group_stage.allowed, true);
  assert.match(actions.reset_group_stage.reason, /5 recorded group result/);
});

test('settings freeze once fixtures exist', () => {
  const open = adminActionAvailability(inputs({ status: 'open' }));
  assert.equal(open.edit_settings.allowed, true);

  const drawn = adminActionAvailability(inputs({ status: 'groups_drawn' }));
  assert.equal(drawn.edit_settings.allowed, false);

  const done = adminActionAvailability(inputs({ status: 'completed' }));
  assert.equal(done.edit_settings.allowed, false);
  assert.match(done.edit_settings.reason, /history/i);
});

test('only drawn tournaments can be marked completed by hand', () => {
  assert.equal(
    adminActionAvailability(inputs({ status: 'bracket_drawn' })).mark_completed.allowed,
    true,
  );
  assert.equal(
    adminActionAvailability(inputs({ status: 'groups_drawn' })).mark_completed.allowed,
    true,
  );
  assert.equal(
    adminActionAvailability(inputs({ status: 'open' })).mark_completed.allowed,
    false,
  );
  assert.equal(
    adminActionAvailability(inputs({ status: 'completed' })).mark_completed.allowed,
    false,
  );
});

/* -------------------------------------------------------------- transitions */

test('completed is a one-way door', () => {
  assert.equal(ALLOWED_STATUS_TRANSITIONS.completed.length, 0);
  assert.equal(canChangeStatus('completed', 'open'), false);
  assert.equal(canChangeStatus('completed', 'groups_drawn'), false);
});

test('draw statuses are never reached by hand', () => {
  assert.equal(canChangeStatus('open', 'groups_drawn'), false);
  assert.equal(canChangeStatus('closed', 'bracket_drawn'), false);
});

test('open and closed are reversible; completion is reachable from the stages', () => {
  assert.equal(canChangeStatus('open', 'closed'), true);
  assert.equal(canChangeStatus('closed', 'open'), true);
  assert.equal(canChangeStatus('groups_drawn', 'completed'), true);
  assert.equal(canChangeStatus('bracket_drawn', 'completed'), true);
});

/* ------------------------------------------------------------ match results */

test('a group result needs two whole scores', () => {
  const ok = validateAdminMatchResult({ kind: 'group', match_id: 'm-1', score_a: 2, score_b: 1 });
  assert.equal(ok.ok, true);

  assert.equal(
    validateAdminMatchResult({ kind: 'group', match_id: 'm-1', score_a: 2 }).ok,
    false,
  );
  assert.equal(
    validateAdminMatchResult({ kind: 'group', match_id: 'm-1', score_a: -1, score_b: 0 }).ok,
    false,
  );
  assert.equal(
    validateAdminMatchResult({ kind: 'group', match_id: 'm-1', score_a: 1.5, score_b: 0 }).ok,
    false,
  );
});

test('a knockout result needs a winner, and it must be one of the two players', () => {
  const ok = validateAdminMatchResult(
    { kind: 'knockout', match_id: 'm-2', winner_id: 'p-a' },
    { player_a_id: 'p-a', player_b_id: 'p-b' },
  );
  assert.equal(ok.ok, true);

  const outsider = validateAdminMatchResult(
    { kind: 'knockout', match_id: 'm-2', winner_id: 'p-z' },
    { player_a_id: 'p-a', player_b_id: 'p-b' },
  );
  assert.equal(outsider.ok, false);
  assert.match(outsider.error, /one of the two players/i);

  assert.equal(
    validateAdminMatchResult({ kind: 'knockout', match_id: 'm-2' }).ok,
    false,
  );
});

test('an unknown kind is rejected', () => {
  const result = validateAdminMatchResult({ kind: 'friendly', match_id: 'm-3' });
  assert.equal(result.ok, false);
  assert.match(result.error, /group.*knockout/i);
});

test('results can only be set on pending or disputed matches', () => {
  assert.equal(canSetResult('pending'), true);
  assert.equal(canSetResult('disputed'), true);
  assert.equal(canSetResult('completed'), false);
});

/* -------------------------------------------------------- tournament inputs */

test('a complete create payload passes', () => {
  const result = validateTournamentInput(createBody(), { mode: 'create' });
  assert.equal(result.ok, true);
  assert.equal(result.value.title, 'DLS Champions Cup #2');
});

test('a create payload missing any field is rejected', () => {
  for (const field of ['title', 'entry_fee', 'max_players', 'registration_deadline', 'match_deadline']) {
    const body: Record<string, unknown> = createBody();
    delete body[field];
    const result = validateTournamentInput(body, { mode: 'create' });
    assert.equal(result.ok, false, `missing ${field} should fail`);
  }
});

test('the size must be a count the knockout format can finish', () => {
  for (const size of [6, 7, 8, 13, 16]) {
    const result = validateTournamentInput(createBody({ max_players: size }), { mode: 'create' });
    assert.equal(result.ok, true, `size ${size} should be allowed`);
  }
  for (const size of [4, 5, 9, 10, 12, 17, 32]) {
    const result = validateTournamentInput(createBody({ max_players: size }), { mode: 'create' });
    assert.equal(result.ok, false, `size ${size} should be refused`);
    assert.match(result.error, /format/i);
  }
});

test('the entry fee has sane bounds', () => {
  assert.equal(validateTournamentInput(createBody({ entry_fee: 50 }), { mode: 'create' }).ok, false);
  assert.equal(
    validateTournamentInput(createBody({ entry_fee: 500000 }), { mode: 'create' }).ok,
    false,
  );
  assert.equal(
    validateTournamentInput(createBody({ entry_fee: 1000.5 }), { mode: 'create' }).ok,
    false,
  );
});

test('the match deadline must follow the registration deadline', () => {
  const result = validateTournamentInput(
    createBody({
      registration_deadline: new Date(Date.now() + 14 * 864e5).toISOString(),
      match_deadline: new Date(Date.now() + 7 * 864e5).toISOString(),
    }),
    { mode: 'create' },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /after the registration deadline/i);
});

test('deadlines in the past are refused (beyond the edit grace window)', () => {
  const result = validateTournamentInput(
    createBody({ registration_deadline: new Date(Date.now() - 3 * 864e5).toISOString() }),
    { mode: 'create' },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /past/i);
});

test('a deadline that slipped a few minutes ago can still be extended', () => {
  // The organizer extending a registration window that just closed must not be
  // told "the past is invalid" — anything within 24h counts as an edit.
  const result = validateTournamentInput(
    createBody({ registration_deadline: new Date(Date.now() - 5 * 60_000).toISOString() }),
    { mode: 'create' },
  );
  assert.equal(result.ok, true);
});

test('the entry fee freezes once registration has closed', () => {
  const current = tournament({ status: 'closed', entry_fee: 1000 });
  const result = validateTournamentInput({ id: 't-1', entry_fee: 2000 }, { mode: 'patch', current });
  assert.equal(result.ok, false);
  assert.match(result.error, /fee/i);
});

test('a patch needs the id and at least one field', () => {
  assert.equal(validateTournamentInput({}, { mode: 'patch' }).ok, false);
  assert.equal(
    validateTournamentInput({ id: 't-1' }, { mode: 'patch', current: tournament() }).ok,
    false,
  );
  const ok = validateTournamentInput({ id: 't-1', title: 'New Name' }, {
    mode: 'patch',
    current: tournament(),
  });
  assert.equal(ok.ok, true);
});

test('a status patch must follow the transition map', () => {
  const current = tournament({ status: 'open' });
  const illegal = validateTournamentInput(
    { id: 't-1', status: 'bracket_drawn' },
    { mode: 'patch', current },
  );
  assert.equal(illegal.ok, false);
  assert.match(illegal.error, /by hand/i);

  const legal = validateTournamentInput({ id: 't-1', status: 'closed' }, {
    mode: 'patch',
    current,
  });
  assert.equal(legal.ok, true);
});
