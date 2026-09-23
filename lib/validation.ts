/**
 * Input validation for the public forms.
 *
 * The browser checks these same rules for instant feedback, and the server
 * checks them again — a player with a modified page must never be able to store
 * junk in the database.
 *
 * MODULE 1: `validateRegistration()` (the registration form).
 * MODULE 2: `validateGroupResult()` (group results).
 * MODULE 3: `validateKnockoutResult()` (knockout results).
 */

import type {
  RegisterPayload,
  SubmitGroupResultPayload,
  SubmitKnockoutResultPayload,
} from '@/types';
import { isValidGhanaPhone, normalizePhone } from './format';

/** Longest sensible length for a name or team name, in characters. */
const MAX_TEXT_LENGTH = 60;

/** Highest score that can be entered for a match (guards typos like 300). */
const MAX_SCORE = 99;

/**
 * Result of a validation pass.
 * `ok: false` always carries a message that can be shown to the player as-is.
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Trims a value and collapses runs of whitespace.
 *
 * @param value Any unknown value from a request body.
 * @returns A cleaned string ('' when the value was not a string).
 */
function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

/**
 * Converts an unknown value into a valid match score.
 *
 * @param value The raw score (number or numeric string).
 * @returns The score as an integer 0-99, or null when it is not valid.
 */
function toScore(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(number) || number < 0 || number > MAX_SCORE) return null;
  return number;
}

/**
 * Validates the registration form payload.
 *
 * Rules enforced:
 * - every field is required and non-empty
 * - the WhatsApp number is a valid Ghanaian mobile number (024XXXXXXX or
 *   05XXXXXXXX — see `isValidGhanaPhone`)
 * - the MoMo number is a valid Ghanaian mobile number
 * - both mandatory checkboxes are ticked
 *
 * @param body The raw request body.
 * @returns The cleaned payload, or an error message written for the player.
 */
export function validateRegistration(
  body: unknown,
): ValidationResult<RegisterPayload> {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Please fill in the registration form.' };
  }

  const input = body as Partial<RegisterPayload>;

  const tournamentId = clean(input.tournament_id);
  const playerName = clean(input.player_name);
  const phone = normalizePhone(clean(input.phone_number));
  const momo = normalizePhone(clean(input.momo_number));
  const teamName = clean(input.dls_team_name);

  if (!tournamentId) {
    return { ok: false, error: 'This tournament could not be found.' };
  }
  if (playerName.length < 2) {
    return { ok: false, error: 'Please enter your full name.' };
  }
  if (playerName.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      error: `Your name must be under ${MAX_TEXT_LENGTH} characters.`,
    };
  }
  if (!isValidGhanaPhone(phone)) {
    return {
      ok: false,
      error: 'Enter a valid WhatsApp number in the format 024XXXXXXX or 05XXXXXXXX.',
    };
  }
  if (!isValidGhanaPhone(momo)) {
    return {
      ok: false,
      error: 'Enter a valid MoMo number in the format 024XXXXXXX or 05XXXXXXXX.',
    };
  }
  if (teamName.length < 2) {
    return { ok: false, error: 'Please enter your DLS team name.' };
  }
  if (teamName.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      error: `Your DLS team name must be under ${MAX_TEXT_LENGTH} characters.`,
    };
  }
  if (input.career_mode_confirmed !== true) {
    return {
      ok: false,
      error:
        'Confirm that you have completed 6 Career Mode matches and can access Friend Match.',
    };
  }
  if (input.rules_accepted !== true) {
    return { ok: false, error: 'You must agree to the tournament rules.' };
  }

  return {
    ok: true,
    value: {
      tournament_id: tournamentId,
      player_name: playerName,
      phone_number: phone,
      momo_number: momo,
      dls_team_name: teamName,
      career_mode_confirmed: true,
      rules_accepted: true,
    },
  };
}

/**
 * Validates a group-match result submission.
 *
 * Rules enforced:
 * - a match id, a phone number and a screenshot URL are all required
 * - the phone number is a valid Ghanaian mobile number
 * - both scores are whole numbers between 0 and 99
 *
 * @param body The raw request body.
 * @returns The cleaned payload, or an error message written for the player.
 */
export function validateGroupResult(
  body: unknown,
): ValidationResult<SubmitGroupResultPayload> {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Please fill in the result form.' };
  }

  const input = body as Partial<SubmitGroupResultPayload>;

  const matchId = clean(input.match_id);
  const phone = normalizePhone(clean(input.phone_number));
  const screenshot = clean(input.screenshot_url);
  const myScore = toScore(input.my_score);
  const opponentScore = toScore(input.opponent_score);

  if (!matchId) {
    return { ok: false, error: 'Please choose the match you are reporting.' };
  }
  if (!isValidGhanaPhone(phone)) {
    return {
      ok: false,
      error:
        'Enter the WhatsApp number you registered with, in the format 024XXXXXXX or 05XXXXXXXX.',
    };
  }
  if (myScore === null || opponentScore === null) {
    return {
      ok: false,
      error: 'Enter both scores as whole numbers between 0 and 99.',
    };
  }
  if (!screenshot) {
    return {
      ok: false,
      error: 'Screenshot is required as proof of your result.',
    };
  }

  return {
    ok: true,
    value: {
      kind: 'group',
      match_id: matchId,
      phone_number: phone,
      my_score: myScore,
      opponent_score: opponentScore,
      screenshot_url: screenshot,
    },
  };
}

/**
 * Validates a knockout-match result submission.
 *
 * Rules enforced:
 * - a match id, a phone number and a screenshot URL are all required
 * - the phone number is a valid Ghanaian mobile number
 * - the player must say whether they won or lost (knockout matches never draw)
 *
 * @param body The raw request body.
 * @returns The cleaned payload, or an error message written for the player.
 */
export function validateKnockoutResult(
  body: unknown,
): ValidationResult<SubmitKnockoutResultPayload> {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Please fill in the result form.' };
  }

  const input = body as Partial<SubmitKnockoutResultPayload>;

  const matchId = clean(input.match_id);
  const phone = normalizePhone(clean(input.phone_number));
  const screenshot = clean(input.screenshot_url);

  if (!matchId) {
    return { ok: false, error: 'Please choose the match you are reporting.' };
  }
  if (!isValidGhanaPhone(phone)) {
    return {
      ok: false,
      error:
        'Enter the WhatsApp number you registered with, in the format 024XXXXXXX or 05XXXXXXXX.',
    };
  }
  if (input.knockout_result !== 'won' && input.knockout_result !== 'lost') {
    return { ok: false, error: 'Choose whether you won or lost the match.' };
  }
  if (!screenshot) {
    return {
      ok: false,
      error: 'Screenshot is required as proof of your result.',
    };
  }

  return {
    ok: true,
    value: {
      kind: 'knockout',
      match_id: matchId,
      phone_number: phone,
      knockout_result: input.knockout_result,
      screenshot_url: screenshot,
    },
  };
}
