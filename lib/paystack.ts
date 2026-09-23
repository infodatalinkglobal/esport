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
 * The platform deliberately has no accounts (no login is in the MVP), but
 * Paystack checkout insists on an email address, so we derive a deterministic
 * one from the player's phone number. Nobody is emailed: the receipt is shown
 * on screen and the MoMo confirmation SMS comes from the network.
 *
 * @param phoneNumber Player's WhatsApp number.
 * @returns An address such as `0241234567@players.dls.local`.
 */
export function buildPlayerEmail(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');
  return `${digits}@players.dls.local`;
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
 * Verifies a transaction with Paystack and, if it really succeeded, marks the
 * matching registration as `paid`.
 *
 * This is the only place where money turns into a confirmed registration, so it
 * is used by `/api/verify-payment` and by the `/payment/verify` callback page.
 *
 * @param reference The Paystack reference to verify.
 * @param supabase Optional service-role client (created on demand when omitted).
 * @returns `{ success, player_name, tournament_id }`; `success` is false with a
 *          user-safe `error` when the payment did not go through.
 */
export async function verifyPayment(
  reference: string,
  supabase?: SupabaseClient,
): Promise<{
  success: boolean;
  player_name: string;
  tournament_id?: string;
  error?: string;
}> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return {
      success: false,
      player_name: '',
      error: 'Payments are not configured yet. Please contact us on WhatsApp.',
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
      };
    }

    data = json.data;
  } catch {
    return {
      success: false,
      player_name: '',
      error: 'We could not reach the payment provider. Please try again.',
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
    };
  }

  // 4. Paystack says the payment did not succeed.
  if (data.status !== 'success') {
    // Record the failure so the player can register again — the phone-number
    // slot is freed up because the unique index only applies per tournament.
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

  // 6. Mark it paid (keep the verified reference so support can trace it).
  const { error: updateError } = await client
    .from('registrations')
    .update({ payment_status: 'paid', paystack_reference: data.reference })
    .eq('id', registration.id);

  if (updateError) {
    console.error('[paystack.verify] update failed', updateError.message);
    return {
      success: false,
      player_name: registration.player_name,
      tournament_id: registration.tournament_id,
      error:
        'Payment received but we could not confirm it. Contact us on WhatsApp.',
    };
  }

  return {
    success: true,
    player_name: registration.player_name,
    tournament_id: registration.tournament_id,
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
