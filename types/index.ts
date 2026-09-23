/**
 * All shared TypeScript types for the DLS Tournament Platform.
 *
 * MODULE 1 (Foundation + Payments):
 *   Tournament, Registration, PaystackConfig, PrizeBreakdown — plus the
 *   request/response types the registration and payment flows need.
 *
 * MODULE 2 (Group Stage):
 *   Group, GroupMember, GroupMatch, GroupStanding, GroupDraw — plus the view
 *   models the standings/fixtures pages render and the result-submission types.
 *
 * MODULE 3 (Knockout) will add its own types (Bracket, KnockoutResult) to this
 * file; nothing already here needs to change for that.
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

/**
 * The safe subset of a registration that may be shown publicly or returned by
 * an admin API. Phone numbers, MoMo numbers and Paystack references are NEVER
 * included.
 */
export interface PublicPlayer {
  /** `registrations.id`. */
  id: string;
  /** Player's full name. */
  player_name: string;
  /** The player's in-game DLS club name. */
  dls_team_name: string;
}

/* ==========================================================================
 * MODULE 2 — group stage rows
 * ========================================================================== */

/** A row of the `groups` table. `group_name` is one of 'A' | 'B' | 'C' | 'D'. */
export interface Group {
  /** Primary key (UUID). */
  id: string;
  /** Tournament this group belongs to. */
  tournament_id: string;
  /** 'A' | 'B' | 'C' | 'D'. */
  group_name: string;
  /** ISO timestamp of row creation. */
  created_at: string;
}

/** A row of the `group_members` table: "{player} plays in {group}". */
export interface GroupMember {
  /** Primary key (UUID). */
  id: string;
  /** The group the player was drawn into. */
  group_id: string;
  /** Denormalised tournament id, so a group page needs one query less. */
  tournament_id: string;
  /** References `registrations.id`. */
  player_id: string;
  /** ISO timestamp of row creation. */
  created_at: string;
}

/**
 * State of a single match.
 *
 * - `pending`   waiting for one or both players to submit a result
 * - `completed` both players agreed (or the organizer decided) — points count
 * - `disputed`  the two submissions contradicted each other
 */
export type MatchStatus = 'pending' | 'completed' | 'disputed';

/** A row of the `group_matches` table (one round-robin fixture). */
export interface GroupMatch {
  /** Primary key (UUID) — the "match id" players select in the result form. */
  id: string;
  /** The group this fixture belongs to. */
  group_id: string;
  /** Denormalised tournament id. */
  tournament_id: string;
  /** 1-based fixture number inside its group (1..6 for a group of 4). */
  match_number: number;
  /** Player A — the higher-seeded player, who generates the Friend Match code. */
  player_a_id: string;
  /** Player B. */
  player_b_id: string;
  /** Player A's score, as agreed (null while no result has been submitted). */
  player_a_score: number | null;
  /** Player B's score, as agreed (null while no result has been submitted). */
  player_b_score: number | null;
  /** Public URL of Player A's scoreboard screenshot (their proof). */
  player_a_screenshot: string | null;
  /** Public URL of Player B's scoreboard screenshot (their proof). */
  player_b_screenshot: string | null;
  /** Winner's `registrations.id`; null for a draw or while undecided. */
  winner_id: string | null;
  /** See {@link MatchStatus}. */
  status: MatchStatus;
  /** ISO timestamp of row creation. */
  created_at: string;
}

/** A row of the `group_standings` table (one row of a group's league table). */
export interface GroupStanding {
  /** Primary key (UUID). */
  id: string;
  /** The group this table row belongs to. */
  group_id: string;
  /** Denormalised tournament id. */
  tournament_id: string;
  /** References `registrations.id`. */
  player_id: string;
  /** Matches played. */
  played: number;
  /** Matches won. */
  won: number;
  /** Matches drawn. */
  drawn: number;
  /** Matches lost. */
  lost: number;
  /** Goals scored. */
  goals_for: number;
  /** Goals conceded. */
  goals_against: number;
  /** goals_for − goals_against. */
  goal_difference: number;
  /** Win = 3, Draw = 1, Loss = 0. */
  points: number;
  /** ISO timestamp of row creation. */
  created_at: string;
}

/**
 * The result of the group draw for one group.
 * Returned by `createGroups()` and by `POST /api/admin/draw-groups`.
 */
export interface GroupDraw {
  /** 'A' | 'B' | 'C' | 'D'. */
  group_name: string;
  /** The players drawn into this group (safe display fields only). */
  players: PublicPlayer[];
  /** Every round-robin fixture created for this group. */
  fixtures: GroupMatch[];
}

/* ==========================================================================
 * MODULE 2 — view models (database rows enriched for rendering)
 * ========================================================================== */

/**
 * A standings row with the player's name joined in and its position calculated.
 *
 * Position comes from the official tiebreaker order:
 * 1. Points  2. Goal difference  3. Goals scored  4. Head-to-head
 * 5. Penalty shootout (the organizer records that decision manually, so the
 *    table falls back to alphabetical order while a shootout is pending).
 */
export interface StandingRow extends GroupStanding {
  /** Player's full name. */
  player_name: string;
  /** Player's DLS club name. */
  dls_team_name: string;
  /** 1-based rank inside the group after the tiebreakers. */
  position: number;
  /** True when position <= 2, i.e. the player advances to the knockout stage. */
  advances: boolean;
}

/** A group together with its sorted league table, ready for `<GroupCard />`. */
export interface GroupWithStandings {
  /** The `groups` row. */
  group: Group;
  /** Sorted standings, position 1 first. */
  standings: StandingRow[];
}

/** A fixture with both player names resolved, ready for `<GroupFixtures />`. */
export interface FixtureView extends GroupMatch {
  /** Group letter, e.g. 'A'. */
  group_name: string;
  /** Player A's display name. */
  player_a_name: string;
  /** Player A's DLS club name. */
  player_a_team: string;
  /** Player B's display name. */
  player_b_name: string;
  /** Player B's DLS club name. */
  player_b_team: string;
  /** Winner's display name once the match is completed (null for a draw). */
  winner_name: string | null;
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
  /** Paystack public key (safe in the browser). */
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

/**
 * Which competition a result belongs to.
 * Module 3 adds the 'knockout' branch; Module 2 only accepts 'group'.
 */
export type MatchKind = 'group' | 'knockout';

/** Body accepted by `POST /api/submit-result` (MODULE 2: group matches only). */
export interface SubmitGroupResultPayload {
  /** Always 'group' in Module 2. */
  kind: 'group';
  /** The `group_matches.id` being reported. */
  match_id: string;
  /** The WhatsApp number the player registered with — identifies their side. */
  phone_number: string;
  /** The score this player says they finished with. */
  my_score: number;
  /** The score this player says their opponent finished with. */
  opponent_score: number;
  /** Public URL of the uploaded scoreboard screenshot (proof). */
  screenshot_url: string;
}

/**
 * What `POST /api/submit-result` returns.
 *
 * - `confirmed: true`  both players agreed → the match is 'completed'
 * - `disputed: true`   the claims contradicted → the match is 'disputed'
 * - neither            only one player has submitted so far; still 'pending'
 */
export interface SubmitResultResponse {
  success: boolean;
  /** The match's status after this submission. */
  status?: MatchStatus;
  /** True when both players agreed and the match was auto-confirmed. */
  confirmed?: boolean;
  /** True when the two submissions contradicted each other. */
  disputed?: boolean;
  /** Winner's `registrations.id`, when the match is completed and not a draw. */
  winner_id?: string | null;
  /** User-safe message explaining what happened. */
  message?: string;
  /** User-safe error message when `success` is false. */
  error?: string;
}

/** One group returned by `POST /api/admin/draw-groups`. */
export interface DrawGroupsResult {
  success: boolean;
  /** The drawn groups, each with its players and generated fixtures. */
  groups: GroupDraw[];
  /** Total number of fixtures created across every group. */
  fixtures_created?: number;
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

/** Props for `<GroupStandingsTable />`. */
export interface GroupStandingsTableProps {
  /** Rows already sorted by the full tiebreaker order. */
  standings: StandingRow[];
  /** Group letter, used for the accessible caption, e.g. 'A'. */
  groupName: string;
}

/** Props for `<GroupFixtures />`. */
export interface GroupFixturesProps {
  /** Fixtures belonging to one group, sorted by match number. */
  fixtures: FixtureView[];
}

/** Props for `<GroupCard />`. */
export interface GroupCardProps {
  /** The group plus its sorted standings. */
  group: GroupWithStandings;
  /** That group's fixtures. */
  fixtures: FixtureView[];
}

/**
 * One selectable match in the result form's dropdown.
 * Built on the server so the browser never sees phone numbers.
 */
export interface MatchOption {
  /** `group_matches.id` (Module 3 will add `brackets.id`). */
  id: string;
  /** Text shown in the dropdown, e.g. "Group A · Match 1: Kofi vs Ama". */
  label: string;
}

/** Props for `<ResultSubmissionForm />`. */
export interface ResultSubmissionFormProps {
  /** Tournament the matches belong to (null when nothing has been drawn yet). */
  tournamentId: string | null;
  /** Group fixtures a player can report. */
  groupMatches: MatchOption[];
  /** Knockout matches — empty in Module 2; filled in by Module 3. */
  knockoutMatches: MatchOption[];
}
