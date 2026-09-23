/**
 * All shared TypeScript types for the DLS Tournament Platform.
 *
 * MODULE 1 (Foundation + Payments):
 *   Tournament, Registration, PaystackConfig, PrizeBreakdown — plus the small
 *   request/response types the registration and payment flows need.
 *
 * Module 2 (group stage) and Module 3 (knockout) will ADD their own types to
 * this file; nothing here needs to change for that to work.
 *
 * Every field name matches the Supabase columns in `setup.sql` exactly, so a
 * database row can be used as a typed object with no mapping layer.
 */

/* ==========================================================================
 * Core database rows
 * ========================================================================== */

/**
 * A tournament's lifecycle stage.
 *
 * - `open`          registration is open and payments are accepted
 * - `closed`        registration closed, waiting for the group draw
 * - `groups_drawn`  group stage in progress
 * - `bracket_drawn` knockout stage in progress
 * - `completed`     tournament finished
 */
export type TournamentStatus =
  | 'open'
  | 'closed'
  | 'groups_drawn'
  | 'bracket_drawn'
  | 'completed';

/** A row of the `tournaments` table. */
export interface Tournament {
  /** Primary key (UUID). */
  id: string;
  /** Display name, e.g. "DLS Champions Cup #1". */
  title: string;
  /** Entry fee in pesewas (Paystack's smallest unit). GH₵10 = 1000. */
  entry_fee: number;
  /** Maximum number of paid players allowed. */
  max_players: number;
  /** ISO timestamp after which registration is rejected. */
  registration_deadline: string;
  /** ISO timestamp shown to players as the deadline for playing matches. */
  match_deadline: string;
  /** Current lifecycle stage (see {@link TournamentStatus}). */
  status: TournamentStatus;
  /** ISO timestamp of row creation. */
  created_at: string;
}

/**
 * Payment state of one registration.
 *
 * `failed` is kept separate from `pending` so a declined/abandoned MoMo payment
 * can be recognised and retried, and so a failed attempt never blocks a phone
 * number from registering again.
 */
export type PaymentStatus = 'pending' | 'paid' | 'failed';

/** A row of the `registrations` table. */
export interface Registration {
  /** Primary key (UUID) — also used as the "player id". */
  id: string;
  /** Tournament this player registered for. */
  tournament_id: string;
  /** Player's full name. */
  player_name: string;
  /** WhatsApp number, format 024XXXXXXX. PRIVATE — never sent to browsers. */
  phone_number: string;
  /** MoMo number used for prize payout. PRIVATE. */
  momo_number: string;
  /** The player's in-game DLS club name. */
  dls_team_name: string;
  /** Paystack transaction reference. Unique. */
  paystack_reference: string;
  /** `paid` once Paystack verification succeeds. */
  payment_status: PaymentStatus;
  /** ISO timestamp of row creation. */
  created_at: string;
}

/* ==========================================================================
 * Paystack
 * ========================================================================== */

/**
 * Configuration for opening the Paystack inline payment popup.
 *
 * Passed to the Paystack client-side library; `onSuccess` receives the
 * transaction reference, which must then be verified on the server (see
 * {@link VerifyPaymentResponse}).
 */
export interface PaystackConfig {
  /** Customer email Paystack requires (we derive it from the phone number). */
  email: string;
  /** Amount in pesewas — 1000 = GH₵10. */
  amount: number;
  /** Unique transaction reference generated when the registration is created. */
  reference: string;
  /** Called after Paystack reports a successful payment. */
  onSuccess: (reference: string) => void;
  /** Called when the player closes the popup without paying. */
  onClose: () => void;
  /** Called when the popup itself fails to load or check out. */
  onError?: (message: string) => void;
}

/**
 * What `POST /api/paystack/initialize` returns to the browser.
 *
 * Two ways to check out are returned on purpose:
 * - the `access_code` opens the in-page popup (primary, mobile friendly)
 * - the `authorization_url` is the hosted checkout page, used automatically
 *   when the popup is blocked or cannot load
 */
export interface PaystackSession {
  /** Transaction reference stored on the registration row. */
  reference: string;
  /** Code that lets the popup resume this exact transaction. */
  access_code: string;
  /** Hosted checkout URL — the redirect fallback. */
  authorization_url: string;
  /** Paystack public key (safe in the browser; used by the classic popup API). */
  public_key: string;
  /** Amount in pesewas. */
  amount: number;
  /** Email given to Paystack. */
  email: string;
}

/* ==========================================================================
 * Money
 * ========================================================================== */

/**
 * The prize-pool breakdown for a tournament.
 *
 * All values are in PESEWAS (whole numbers), so no floating-point rounding can
 * ever leak into a payout. Divide by 100 for a GH₵ amount, or use
 * `formatCedis()`.
 */
export interface PrizeBreakdown {
  /** Number of players the calculation is based on. */
  totalPlayers: number;
  /** totalPlayers × entry fee — everything collected. */
  totalPot: number;
  /** The organizer's 15% cut of the total pot. */
  organizerShare: number;
  /** totalPot − organizerShare — the money actually won. */
  prizePot: number;
  /** 70% of the prize pot — 1st place. */
  winnerPrize: number;
  /** 30% of the prize pot — 2nd place. */
  runnerUpPrize: number;
}

/* ==========================================================================
 * API request / response payloads
 * ========================================================================== */

/** Body accepted by `POST /api/register`. */
export interface RegisterPayload {
  /** Tournament being entered. */
  tournament_id: string;
  /** Player's full name. */
  player_name: string;
  /** WhatsApp number, 024XXXXXXX or 05XXXXXXXX. */
  phone_number: string;
  /** MoMo number for the prize payout. */
  momo_number: string;
  /** The player's DLS club name. */
  dls_team_name: string;
  /** "I have completed 6 Career Mode matches and can access Friend Match". */
  career_mode_confirmed: boolean;
  /** "I agree to the tournament rules". */
  rules_accepted: boolean;
}

/**
 * What `POST /api/register` returns.
 *
 * `entry_fee_label` is pre-formatted on the server so the client never has to
 * duplicate the pesewa → cedi conversion.
 */
export interface RegisterResponse {
  success: boolean;
  /** The `pending` registration that was created (or refreshed). */
  registration_id?: string;
  /** Paystack reference stored on that registration. */
  reference?: string;
  /** Entry fee in pesewas. */
  entry_fee?: number;
  /** Entry fee ready to display, e.g. "GH₵10.00". */
  entry_fee_label?: string;
  /** Tournament title, for the payment panel. */
  tournament_title?: string;
  /** User-safe error message when `success` is false. */
  error?: string;
  /**
   * Machine-readable reason for the failure, used to decide which extra help
   * (like a WhatsApp button) to show: 'full' | 'closed' | 'deadline_passed' |
   * 'duplicate' | 'already_paid'.
   */
  code?: string;
}

/** Body accepted by `POST /api/verify-payment`. */
export interface VerifyPaymentPayload {
  /** The Paystack reference to check. */
  reference: string;
}

/**
 * What `POST /api/verify-payment` returns.
 *
 * `success: true` means Paystack confirmed the money AND the registration row
 * was updated to 'paid'.
 */
export interface VerifyPaymentResponse {
  success: boolean;
  /** The player's name, shown on the success page. */
  player_name: string;
  /** Tournament they registered for. */
  tournament_id?: string | null;
  /** User-safe error message when `success` is false. */
  error?: string;
}

/* ==========================================================================
 * Component props
 * ========================================================================== */

/** Props for `<CountdownTimer />`. */
export interface CountdownTimerProps {
  /** ISO timestamp (or epoch milliseconds) to count down to. */
  targetDate: string | number;
  /** Optional heading shown above the digits. */
  label?: string;
  /** Called once when the countdown reaches zero. */
  onComplete?: () => void;
}

/** Props for `<PrizeBreakdown />`. */
export interface PrizeBreakdownProps {
  /** The calculated breakdown, in pesewas. */
  prizes: PrizeBreakdown;
  /** True when the tournament is not full yet, so amounts are "if full". */
  isProjected?: boolean;
}

/** Props for `<RegistrationForm />`. */
export interface RegistrationFormProps {
  /** Tournament the player is entering. */
  tournamentId: string;
  /** Entry fee ready to display, e.g. "GH₵10.00". */
  entryFeeLabel: string;
  /** False when registration is closed or the deadline has passed. */
  isOpen: boolean;
  /** True when every player slot is taken. */
  isFull: boolean;
  /** How many slots are still free. */
  spotsLeft: number;
}

/** Props for `<PaystackButton />`. */
export interface PaystackButtonProps {
  /** The `pending` registration this payment belongs to. */
  registrationId: string;
  /** Amount ready to display, e.g. "GH₵10.00". */
  amountLabel: string;
  /** Called with the reference once Paystack reports success. */
  onSuccess?: (reference: string) => void;
}
