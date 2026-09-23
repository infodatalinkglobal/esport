/**
 * Input validation for the registration form.
 *
 * The browser checks these same rules for instant feedback, and the server
 * checks them again — a player with a modified page must never be able to store
 * junk in the database.
 *
 * Module 2 and Module 3 will add `validateSubmitResult()` for the result form.
 */

import type { RegisterPayload } from '@/types';
import { isValidGhanaPhone, normalizePhone } from './format';

/** Longest sensible length for a name or team name, in characters. */
const MAX_TEXT_LENGTH = 60;

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
