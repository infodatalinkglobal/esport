/**
 * Paystack helpers — server-side REST calls plus the client-side inline popup.
 *
 * THE PAYMENT FLOW (and why it is built this way)
 * ----------------------------------------------
 * 1. `POST /api/register` creates the registration with status 'pending' and a
 *    unique reference, exactly as the MVP spec requires.
 * 2. `POST /api/paystack/initialize` asks Paystack (server-side, with the
 *    secret key) to create the transaction. Paystack answers with an
 *    `access_code` and an `authorization_url`. Both are sent to the browser.
 * 3. The browser opens the Paystack popup with `resumeTransaction(access_code)`
 *    — a mobile-friendly overlay that never leaves our site.
 * 4. If the popup cannot load (ad-blocker, data saver, blocked iframe) or the
 *    player cancels, the browser is sent to `authorization_url` instead. Same
 *    transaction, different checkout surface: this is the automatic fallback
 *    required by the spec.
 * 5. Either way the browser ends up on `/payment/verify?reference=...`, which
 *    verifies the money with the secret key before the registration is marked
 *    'paid'.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The base URL of the Paystack API. */
const PAYSTACK_API = 'https://api.paystack.co';

/** Shape of the subset of the Paystack initialize response we rely on. */
export interface PaystackInitializeData {
  /** The transaction reference Paystack accepted. */
  reference: string;
  /** Hosted checkout URL — the redirect fallback target. */
  authorization_url: string;
  /** Short code that lets the inline popup open this exact transaction. */
  access_code: string;
}

/** Shape of the subset of the Paystack verify response we rely on. */
export interface PaystackVerifyData {
  /** Paystack's transaction id. */
  id: number;
  /** `success` when the payment completed. */
  status: string;
  /** Reference echoed back. */
  reference: string;
  /** Amount actually received, in pesewas. */
  amount: number;
  /** ISO currency code, always 'GHS' for us. */
  currency: string;
  /** Customer email Paystack was given. */
  customer?: { email?: string };
  /** Metadata we attached at initialization (holds our registration id). */
  metadata?: Record<string, unknown> | null;
}

/**
 * Builds the placeholder email Paystack requires.
 *
 * The platform has no logins, but Paystack insists on an email address, so we
 * derive a deterministic one from the player's phone number. Nobody is emailed.
 *
 * The address must look like a normal public one: Paystack rejects reserved
 * TLDs (.local, .test, .invalid) and an all-digits address, both with
 * "Invalid Email Address Passed", which blocks every payment.
 *
 * @param phoneNumber Player's WhatsApp number.
 * @returns An address such as `player0241234567@players.dlstournament.com`.
 */
export function buildPlayerEmail(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');
  return 'player' + digits + '@players.dlstournament.com';
}

/**
 * Creates a transaction reference.
 *
 * Paystack allows letters, numbers and `-`, `.`, `=` — we use an uppercase
 * prefix so references are easy to spot in the Paystack dashboard.
 *
 * @param registrationId The registration this payment belongs to.
 * @returns A unique reference, e.g. `DLS-3F2A9C-1K7QX2`.
 */
export function buildReference(registrationId: string): string {
  const shortId = registrationId.replace(/-/g, '').slice(0, 6).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `DLS-${shortId}-${random}`;
}

/**
 * Initializes a Paystack transaction.
 *
 * @param params.reference Unique reference (we generate it from the registration id).
 * @param params.amount Amount in pesewas.
 * @param params.email Customer email (see {@link buildPlayerEmail}).
 * @param params.callbackUrl Where Paystack sends the browser after payment.
 * @param params.metadata Extra key/values Paystack stores with the transaction.
 * @returns The initialize response data (reference, access_code, authorization_url).
 * @throws Error with a user-safe message when Paystack rejects the request.
 */
export async function initializePayment(params: {
  reference: string;
  amount: number;
  email: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}): Promise<PaystackInitializeData> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    throw new Error('Payments are not configured yet. Please try again later.');
  }

  const response = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      reference: params.reference,
      amount: params.amount, // pesewas
      email: params.email,
      currency: 'GHS',
      callback_url: params.callbackUrl,
      // Mobile money only, so the checkout opens straight on the MTN MoMo /
      // Vodafone Cash / AirtelTigo options the players actually use.
      channels: ['mobile_money'],
      metadata: params.metadata ?? {},
    }),
    cache: 'no-store',
  });

  const json = (await response.json()) as {
    status?: boolean;
    message?: string;
    data?: PaystackInitializeData;
  };

  if (!response.ok || !json.status || !json.data) {
    // Log the real reason for the organizer, show a friendly one to the player.
    console.error('[paystack.initialize]', json.message ?? response.status);
    throw new Error('We could not start the payment. Please try again.');
  }

  return json.data;
}

/**
 * Paystack transaction statuses that can never become 'success' later.
 * Only these may flip a registration to 'failed' — 'ongoing'/'pending' mean
 * the MoMo prompt is still in flight, and treating them as failures used to
 * mark paying players as failed while their money was mid-flight.
 */
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'abandoned', 'reversed']);

/**
 * Why `verifyPayment()` did not confirm a payment. Callers use the code to
 * decide between "show the player a message", "return 500 so Paystack retries"
 * and "log and accept the delivery".
 */
export type VerifyFailureCode =
  | 'not_configured'
  | 'not_found'
  | 'lookup_failed'
  | 'verification_failed'
  | 'still_pending'
  | 'payment_failed'
  | 'amount_mismatch'
  | 'update_failed'
  | 'tournament_full';

export interface VerifyPaymentResult {
  success: boolean;
  player_name: string;
  tournament_id?: string;
  error?: string;
  /** Machine-readable reason when `success` is false (see VerifyFailureCode). */
  code?: VerifyFailureCode;
}

/**
 * Verifies a transaction with Paystack and, if it really succeeded, marks the
 * matching registration as `paid` — through the atomic, capacity-checked
 * `mark_registration_paid()` database function, so a full tournament can never
 * be oversold by two payments confirming at the same instant.
 *
 * This is the only place where money turns into a confirmed registration, so it
 * is used by `/api/verify-payment`, the `/payment/verify` callback page and the
 * signed webhook.
 *
 * @param reference The Paystack reference to verify.
 * @param supabase Optional service-role client (created on demand when omitted).
 * @returns {@link VerifyPaymentResult}; `success` is false with a user-safe
 *          `error` and a machine-readable `code` when it did not confirm.
 */
export async function verifyPayment(
  reference: string,
  supabase?: SupabaseClient,
): Promise<VerifyPaymentResult> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return {
      success: false,
      player_name: '',
      error: 'Payments are not configured yet. Please contact us on WhatsApp.',
      code: 'not_configured',
    };
  }

  // 1. Ask Paystack what really happened.
  let data: PaystackVerifyData;
  try {
    const response = await fetch(
      `${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${secretKey}` },
        cache: 'no-store',
      },
    );

    const json = (await response.json()) as {
      status?: boolean;
      message?: string;
      data?: PaystackVerifyData;
    };

    if (!response.ok || !json.status || !json.data) {
      return {
        success: false,
        player_name: '',
        error: 'We could not find that payment. Please contact us on WhatsApp.',
        code: 'not_found',
      };
    }

    data = json.data;
  } catch {
    return {
      success: false,
      player_name: '',
      error: 'We could not reach the payment provider. Please try again.',
      code: 'verification_failed',
    };
  }

  const client = supabase ?? (await import('./supabase')).supabaseAdmin();

  // 2. Find the registration that owns this reference.
  let registration: {
    id: string;
    player_name: string;
    tournament_id: string;
    payment_status: string;
  } | null = null;

  const byReference = await client
    .from('registrations')
    .select('id, player_name, tournament_id, payment_status')
    .eq('paystack_reference', reference)
    .maybeSingle();

  if (byReference.error) {
    return {
      success: false,
      player_name: '',
      error:
        'Payment received but we could not update your registration. Contact us on WhatsApp.',
      code: 'lookup_failed',
    };
  }

  registration = byReference.data;

  // 3. Safety net: if the reference is unknown, fall back to the registration
  //    id we attach as metadata when the transaction is created.
  if (!registration) {
    const metadataId = data.metadata?.registration_id;
    if (typeof metadataId === 'string' && metadataId) {
      const byMetadata = await client
        .from('registrations')
        .select('id, player_name, tournament_id, payment_status')
        .eq('id', metadataId)
        .maybeSingle();
      registration = byMetadata.data ?? null;
    }
  }

  if (!registration) {
    return {
      success: false,
      player_name: '',
      error:
        'We could not match that payment to a registration. Contact us on WhatsApp.',
      code: 'not_found',
    };
  }

  // 4. Paystack says the payment has not succeeded (yet).
  if (data.status !== 'success') {
    if (TERMINAL_FAILURE_STATUSES.has(data.status)) {
      // Genuinely dead — record the failure so the player can register again;
      // the phone-number slot is freed up because the unique index applies per
      // tournament only.
      await client
        .from('registrations')
        .update({ payment_status: 'failed' })
        .eq('id', registration.id);

      return {
        success: false,
        player_name: registration.player_name,
        tournament_id: registration.tournament_id,
        error:
          'That payment did not go through. You can try again, or contact us on WhatsApp.',
        code: 'payment_failed',
      };
    }

    // 'ongoing' / 'pending' / anything still in flight: the MoMo prompt may
    // still be on the player's phone. Never mark 'failed' here — the signed
    // webhook will confirm the payment the moment it lands.
    return {
      success: false,
      player_name: registration.player_name,
      tournament_id: registration.tournament_id,
      error:
        'Your payment is still being confirmed. Give it a minute, then check again — do not pay twice.',
      code: 'still_pending',
    };
  }

  // The reference must also be for this tournament's exact charge. This stops
  // a successful but cheaper/different-currency transaction being credited.
  const { data: tournament, error: tournamentError } = await client
    .from('tournaments')
    .select('entry_fee, max_players')
    .eq('id', registration.tournament_id)
    .maybeSingle();

  if (
    tournamentError ||
    !tournament ||
    data.currency !== 'GHS' ||
    data.amount !== tournament.entry_fee
  ) {
    console.error('[paystack.verify] amount/currency mismatch', {
      reference,
      receivedAmount: data.amount,
      receivedCurrency: data.currency,
    });
    return {
      success: false,
      player_name: registration.player_name,
      tournament_id: registration.tournament_id,
      error: 'The payment details do not match this tournament. Contact us on WhatsApp.',
      code: 'amount_mismatch',
    };
  }

  // 5. Already verified earlier — idempotent, nothing left to do.
  if (registration.payment_status === 'paid') {
    return {
      success: true,
      player_name: registration.player_name,
      tournament_id: registration.tournament_id,
    };
  }

  // 6. Claim the slot — atomically and capacity-checked. The database function
  //    locks the tournament row while it counts paid players, so two payments
  //    confirming at the same instant can never oversell a full tournament.
  //    It returns false when the tournament is full: the money is real, but the
  //    row must stay unpaid so the organizer can refund.
  const claimed = await client.rpc('mark_registration_paid', {
    p_registration_id: registration.id,
    p_reference: data.reference,
  });

  if (!claimed.error) {
    if (claimed.data === true) {
      return {
        success: true,
        player_name: registration.player_name,
        tournament_id: registration.tournament_id,
      };
    }

    console.error('[paystack.verify] tournament full — payment not credited', {
      reference,
      registration_id: registration.id,
    });
    return {
      success: false,
      player_name: registration.player_name,
      tournament_id: registration.tournament_id,
      error:
        'Payment received, but the last slot was just taken. We will refund you — please contact us on WhatsApp.',
      code: 'tournament_full',
    };
  }

  // 7. Fallback for databases that have not run the hardening migration yet:
  //    count first, then a conditional update. Not perfectly atomic, but far
  //    better than an unconditional write, and it keeps verification working.
  const isMissingFunction =
    claimed.error.code === 'PGRST202' ||
    /function .* does not exist/i.test(claimed.error.message ?? '');

  if (isMissingFunction) {
    console.warn(
      '[paystack.verify] mark_registration_paid() missing — run the 20260924000000 hardening migration for full oversell protection',
    );

    const { count: paidNow } = await client
      .from('registrations')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', registration.tournament_id)
      .eq('payment_status', 'paid');

    if ((paidNow ?? 0) >= (tournament.max_players ?? 0)) {
      return {
        success: false,
        player_name: registration.player_name,
        tournament_id: registration.tournament_id,
        error:
          'Payment received, but the last slot was just taken. We will refund you — please contact us on WhatsApp.',
        code: 'tournament_full',
      };
    }

    const { data: updatedRows, error: updateError } = await client
      .from('registrations')
      .update({ payment_status: 'paid', paystack_reference: data.reference })
      .eq('id', registration.id)
      .neq('payment_status', 'paid')
      .select('id');

    if (updateError) {
      console.error('[paystack.verify] update failed', updateError.message);
      return {
        success: false,
        player_name: registration.player_name,
        tournament_id: registration.tournament_id,
        error:
          'Payment received but we could not confirm it. Contact us on WhatsApp.',
        code: 'update_failed',
      };
    }

    if (!updatedRows || updatedRows.length === 0) {
      // Someone else confirmed this registration between our read and write.
      return {
        success: true,
        player_name: registration.player_name,
        tournament_id: registration.tournament_id,
      };
    }

    return {
      success: true,
      player_name: registration.player_name,
      tournament_id: registration.tournament_id,
    };
  }

  console.error('[paystack.verify] claim failed', claimed.error.message);
  return {
    success: false,
    player_name: registration.player_name,
    tournament_id: registration.tournament_id,
    error:
      'Payment received but we could not confirm it. Contact us on WhatsApp.',
    code: 'update_failed',
  };
}

/* ==========================================================================
 * Browser-side inline popup
 * ========================================================================== */

/** Callbacks accepted by both popup APIs. */
export interface PaystackPopupCallbacks {
  /** Called once the checkout form is visible to the player. */
  onLoad?: () => void;
  /** Called when the player completes the payment. */
  onSuccess: (response: { reference: string }) => void;
  /** Called when the player closes the popup without paying. */
  onCancel?: () => void;
  /** Called when the popup itself fails. */
  onError?: (error: { message?: string }) => void;
}

/** The modern inline API (`new PaystackPop()` + `resumeTransaction`). */
interface PaystackPopConstructor {
  new (): {
    resumeTransaction?: (
      accessCode: string,
      callbacks: PaystackPopupCallbacks,
    ) => unknown;
    resumeTransactionWithAccessCode?: (
      accessCode: string,
      callbacks: PaystackPopupCallbacks,
    ) => unknown;
  };
}

/** The classic v1 inline API (`PaystackPop.setup({...}).openIframe()`). */
interface PaystackPopStatic {
  setup: (options: {
    key: string;
    email: string;
    amount: number;
    currency?: string;
    ref: string;
    channels?: string[];
    metadata?: Record<string, unknown>;
    onClose: () => void;
    callback: (response: { reference: string }) => void;
  }) => { openIframe: () => void };
}

/** Global installed by the Paystack inline script. */
declare global {
  interface Window {
    PaystackPop?: PaystackPopConstructor & PaystackPopStatic;
  }
}

/** URL of the Paystack inline popup script (the classic v1 build). */
export const PAYSTACK_INLINE_SCRIPT = 'https://js.paystack.co/v1/inline.js';

/** How long to wait for the inline script before giving up, in milliseconds. */
const SCRIPT_TIMEOUT_MS = 8000;

/**
 * Loads the Paystack inline script once and resolves when it is available.
 *
 * @param timeoutMs How long to wait before giving up (default 8 seconds).
 * @returns The global `PaystackPop` object.
 * @throws Error when the script cannot be loaded (network blocker, ad-blocker,
 *         or a very slow connection). The caller then uses the redirect flow.
 */
export function loadPaystackScript(
  timeoutMs = SCRIPT_TIMEOUT_MS,
): Promise<NonNullable<Window['PaystackPop']>> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Paystack can only be loaded in the browser.'));
      return;
    }

    if (window.PaystackPop) {
      resolve(window.PaystackPop);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${PAYSTACK_INLINE_SCRIPT}"]`,
    );
    const script = existing ?? document.createElement('script');
    let settled = false;

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('The payment window took too long to load.'));
    }, timeoutMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (window.PaystackPop) {
        resolve(window.PaystackPop);
      } else {
        reject(new Error('The payment window could not be loaded.'));
      }
    };

    script.addEventListener('load', finish);
    script.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(new Error('The payment window could not be loaded.'));
    });

    if (!existing) {
      script.src = PAYSTACK_INLINE_SCRIPT;
      script.async = true;
      document.body.appendChild(script);
    }
  });
}

/**
 * Opens the Paystack checkout as an in-page popup for an already initialized
 * transaction.
 *
 * Both published shapes of the Paystack inline API are supported, because the
 * v1 script (a static object with `setup`) and the newer inline-js (a
 * constructor with `resumeTransaction`) are both in circulation:
 *
 * - constructor shape -> `new PaystackPop().resumeTransaction(access_code, cb)`
 * - static shape      -> `PaystackPop.setup({ ...same reference... }).openIframe()`
 *
 * @param params.accessCode Access code from {@link initializePayment}.
 * @param params.reference The transaction reference (needed by the static API).
 * @param params.publicKey Paystack public key (needed by the static API).
 * @param params.email Customer email (needed by the static API).
 * @param params.amount Amount in pesewas (needed by the static API).
 * @param params.callbacks onSuccess / onCancel / onError handlers.
 * @returns True when a popup was opened, false when the caller must fall back
 *          to the redirect flow.
 */
export async function openPaystackPopup(params: {
  accessCode: string;
  reference: string;
  publicKey: string;
  email: string;
  amount: number;
  callbacks: PaystackPopupCallbacks;
}): Promise<boolean> {
  const PaystackPop = await loadPaystackScript();

  // --- Modern inline-js: PaystackPop is a constructor. -------------------
  if (typeof PaystackPop === 'function') {
    try {
      const popup = new (PaystackPop as unknown as new () => object)() as {
        resumeTransaction?: (code: string, cb: PaystackPopupCallbacks) => unknown;
      };

      if (typeof popup.resumeTransaction === 'function') {
        popup.resumeTransaction(params.accessCode, params.callbacks);
        return true;
      }
    } catch {
      // Fall through to the classic API below.
    }
  }

  // --- Classic v1 inline script: PaystackPop.setup(...).openIframe() -----
  if (typeof PaystackPop.setup === 'function') {
    PaystackPop.setup({
      key: params.publicKey,
      email: params.email,
      amount: params.amount,
      currency: 'GHS',
      ref: params.reference,
      channels: ['mobile_money'],
      callback: params.callbacks.onSuccess,
      onClose: () => params.callbacks.onCancel?.(),
    }).openIframe();
    return true;
  }

  return false;
}
