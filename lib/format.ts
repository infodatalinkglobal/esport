/**
 * Small display helpers. Keeping them in one place means dates, phone numbers
 * and links look identical everywhere on the site.
 *
 * Dates are formatted in the Ghana timezone so the server and the browser
 * always produce exactly the same string (no hydration mismatches, no "yesterday"
 * off-by-one for players near midnight).
 *
 * Module 2 adds the match-status helpers at the bottom of this file.
 */

import type { MatchStatus } from '@/types';

/** Timezone used for every date the players see. */
const GHANA_TIMEZONE = 'Africa/Accra';

/**
 * Formats an ISO timestamp for display.
 *
 * @param iso ISO date string (or null/undefined).
 * @returns e.g. "Sat 27 Sep 2026, 6:00 PM", or "—" when the value is missing.
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: GHANA_TIMEZONE,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/**
 * Keeps only the digits of a phone number and normalises the Ghanaian form.
 *
 * Accepts `0241234567`, `+233241234567`, `233241234567`, `024 123 4567` and
 * always returns the local `0241234567` form, which is how registrations are
 * stored and compared.
 *
 * @param phone Any user-typed phone number.
 * @returns The normalised local number, or just the digits if it does not match.
 */
export function normalizePhone(phone: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');

  // +233 / 233 international prefix → local 0-prefixed number.
  if (digits.length === 12 && digits.startsWith('233')) {
    return `0${digits.slice(3)}`;
  }
  // 9 digits without the leading zero (e.g. 241234567) → add the zero.
  if (digits.length === 9) {
    return `0${digits}`;
  }

  return digits;
}

/**
 * Validates a Ghanaian mobile number.
 *
 * Callers can quote the rule as "024XXXXXXX or 05XXXXXXXX". The pattern accepts
 * 10 digits starting with 0 and a second digit of 2, 3, 4 or 5, which covers
 * every network the players use:
 *   02x / 05x  MTN and Telecel (Vodafone) — e.g. 024, 054, 055, 059, 020, 050
 *   03x        AirtelTigo / others        — e.g. 026, 027, 056, 057
 *
 * @param phone Raw user input.
 * @returns True when it is a valid 10-digit local mobile number.
 */
export function isValidGhanaPhone(phone: string): boolean {
  return /^0[2-5][0-9]{8}$/.test(normalizePhone(phone));
}

/**
 * Builds a WhatsApp deep link.
 *
 * @param phoneNumber International number, digits only (e.g. 233241234567).
 *                    When omitted, `NEXT_PUBLIC_WHATSAPP_CONTACT` is used.
 * @param message Optional pre-filled message text.
 * @returns A `https://wa.me/...` link that opens in the WhatsApp app on mobile.
 */
export function whatsappLink(phoneNumber?: string, message?: string): string {
  const contact =
    phoneNumber ?? process.env.NEXT_PUBLIC_WHATSAPP_CONTACT ?? '233000000000';
  const digits = contact.replace(/\D/g, '');
  const query = message ? `?text=${encodeURIComponent(message)}` : '';
  return `https://wa.me/${digits}${query}`;
}

/**
 * The invite link for the players' WhatsApp community group.
 *
 * @returns The configured group invite URL, or a direct message to the
 *          organizer when no group link is set yet — so the button on the
 *          success page is never dead.
 */
export function whatsappGroupLink(): string {
  return (
    process.env.NEXT_PUBLIC_WHATSAPP_GROUP_INVITE_URL ??
    whatsappLink(undefined, 'Hi! I just registered for the DLS tournament.')
  );
}

/**
 * The public base URL of this deployment, without a trailing slash.
 * Used for the Paystack callback URL and the "challenge a friend" share link.
 *
 * @returns e.g. "https://dls-tournament.vercel.app", or http://localhost:3000
 *          during local development.
 */
export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/+$/, '');

  // Vercel provides the deployment URL automatically on every deployment.
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;

  return 'http://localhost:3000';
}

/* ==========================================================================
 * MODULE 2 — match status display helpers
 * ========================================================================== */

/**
 * A short, friendly label for a match status, used in the status badges.
 *
 * @param status 'pending' | 'completed' | 'disputed'
 * @returns e.g. 'Pending', 'Completed', 'Disputed'.
 */
export function matchStatusLabel(status: MatchStatus): string {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'disputed':
      return 'Disputed';
    default:
      return 'Pending';
  }
}

/**
 * The emoji that goes in front of a match status, as used in the brief.
 *
 * @param status 'pending' | 'completed' | 'disputed'
 * @returns 🟡 for pending, ✅ for completed, 🔴 for disputed.
 */
export function matchStatusEmoji(status: MatchStatus): string {
  switch (status) {
    case 'completed':
      return '✅';
    case 'disputed':
      return '🔴';
    default:
      return '🟡';
  }
}

/**
 * Tailwind classes for a match-status badge.
 *
 * @param status 'pending' | 'completed' | 'disputed'
 * @returns Class names for the badge element.
 */
export function matchStatusClasses(status: MatchStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-pitch-500/15 text-pitch-400 border-pitch-500/40';
    case 'disputed':
      return 'bg-red-500/15 text-red-300 border-red-500/40';
    default:
      return 'bg-white/10 text-white/70 border-white/20';
  }
}
