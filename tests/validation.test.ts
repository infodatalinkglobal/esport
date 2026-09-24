/**
 * Server-side input validation (lib/validation.ts).
 *
 * Focus: the coercion edges that used to accept junk — empty strings that
 * `Number('')` turns into 0, and screenshot "URLs" that were stored unvalidated.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateGroupResult,
  validateKnockoutResult,
  isValidScreenshotUrl,
} from '../lib/validation';

const GROUP_BASE = {
  kind: 'group',
  match_id: 'match-1',
  phone_number: '0241234567',
};

const KNOCKOUT_BASE = {
  kind: 'knockout',
  match_id: 'match-1',
  phone_number: '0241234567',
  knockout_result: 'won',
};

const HTTPSCREENSHOT = 'https://abc123.supabase.co/storage/v1/object/public/result-screenshots/t/m/1.jpg';

test('blank score fields are rejected, not coerced to 0', () => {
  const emptyStrings = validateGroupResult({
    ...GROUP_BASE,
    my_score: '',
    opponent_score: '',
    screenshot_url: HTTPSCREENSHOT,
  });
  assert.equal(emptyStrings.ok, false, 'empty strings must not become 0–0');

  const missing = validateGroupResult({
    ...GROUP_BASE,
    screenshot_url: HTTPSCREENSHOT,
  });
  assert.equal(missing.ok, false);

  const whitespace = validateGroupResult({
    ...GROUP_BASE,
    my_score: '   ',
    opponent_score: '0',
    screenshot_url: HTTPSCREENSHOT,
  });
  assert.equal(whitespace.ok, false);
});

test('valid scores still pass, including genuine zeros', () => {
  const ok = validateGroupResult({
    ...GROUP_BASE,
    my_score: 0,
    opponent_score: '3',
    screenshot_url: HTTPSCREENSHOT,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.my_score, 0);
    assert.equal(ok.value.opponent_score, 3);
  }
});

test('out-of-range and non-integer scores are rejected', () => {
  for (const bad of [-1, 100, 1.5, 'two', true, null]) {
    const result = validateGroupResult({
      ...GROUP_BASE,
      my_score: bad as never,
      opponent_score: 1,
      screenshot_url: HTTPSCREENSHOT,
    });
    assert.equal(result.ok, false, `${String(bad)} must be rejected`);
  }
});

test('screenshot URLs must be bounded-length https URLs', () => {
  assert.equal(isValidScreenshotUrl(HTTPSCREENSHOT), true);
  assert.equal(isValidScreenshotUrl('http://insecure.example/x.jpg'), false);
  assert.equal(isValidScreenshotUrl('javascript:alert(1)'), false);
  assert.equal(isValidScreenshotUrl('not a url'), false);
  assert.equal(isValidScreenshotUrl(''), false);
  assert.equal(isValidScreenshotUrl('https://a.b/' + 'x'.repeat(600)), false);
  assert.equal(isValidScreenshotUrl(undefined), false);
  assert.equal(isValidScreenshotUrl(42), false);
});

test('a javascript: screenshot URL is rejected by both validators', () => {
  const group = validateGroupResult({
    ...GROUP_BASE,
    my_score: 2,
    opponent_score: 1,
    screenshot_url: 'javascript:alert(1)',
  });
  assert.equal(group.ok, false);

  const knockout = validateKnockoutResult({
    ...KNOCKOUT_BASE,
    screenshot_url: 'javascript:alert(1)',
  });
  assert.equal(knockout.ok, false);
});

test('knockout results still require won/lost and a valid URL', () => {
  const badResult = validateKnockoutResult({
    ...KNOCKOUT_BASE,
    knockout_result: 'drew',
    screenshot_url: HTTPSCREENSHOT,
  });
  assert.equal(badResult.ok, false);

  const ok = validateKnockoutResult({
    ...KNOCKOUT_BASE,
    screenshot_url: HTTPSCREENSHOT,
  });
  assert.equal(ok.ok, true);
});
