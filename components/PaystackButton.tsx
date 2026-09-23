'use client';

/**
 * The "Pay & Register" button (Paystack payment step).
 *
 * It implements the payment behaviour Module 1 requires:
 *
 * 1. Ask the server to initialize the Paystack transaction. The secret key and
 *    the amount stay on the server, so neither can be tampered with in the
 *    browser.
 * 2. Open the Paystack inline popup — the mobile-friendly checkout that never
 *    leaves our page.
 * 3. AUTOMATIC FALLBACK: if the popup cannot load (ad-blocker, data saver,
 *    blocked iframe, checkout error) the browser is sent to Paystack's hosted
 *    checkout page instead. Same transaction, different surface. There is also
 *    a manual "Open the Paystack checkout page" link as a last resort — a popup
 *    blocker can never stop a player from paying.
 * 4. On success the reference is handed to /payment/verify, which confirms the
 *    money with Paystack before the registration is marked 'paid'.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PaystackButtonProps } from '@/types';
import { openPaystackPopup } from '@/lib/paystack';
import { whatsappLink } from '@/lib/format';

/** What the button is doing right now. */
type Phase = 'idle' | 'starting' | 'popup' | 'redirecting';

/** Shape of the /api/paystack/initialize response. */
interface InitializeResponse {
  success: boolean;
  reference: string;
  access_code: string;
  authorization_url: string;
  public_key: string;
  amount: number;
  email: string;
  error?: string;
}

/**
 * Renders the payment button, its status text and any error message.
 *
 * @param props.registrationId The pending registration to pay for.
 * @param props.amountLabel Entry fee ready to display, e.g. "GH₵10.00".
 * @param props.onSuccess Optional callback receiving the Paystack reference.
 */
export default function PaystackButton({
  registrationId,
  amountLabel,
  onSuccess,
}: PaystackButtonProps) {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  // Kept so the fallback can redirect without asking the server again.
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  /**
   * Sends the browser to Paystack's hosted checkout page (the fallback).
   *
   * @param url The `authorization_url` returned by the initialize endpoint.
   */
  const redirectToCheckout = (url: string) => {
    setPhase('redirecting');
    // Full navigation: Paystack handles the rest and returns to /payment/verify.
    window.location.href = url;
  };

  /**
   * Starts (or restarts) the payment.
   */
  const startPayment = async () => {
    setError(null);
    setPhase('starting');

    try {
      const response = await fetch('/api/paystack/initialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registration_id: registrationId }),
      });

      const data = (await response.json()) as InitializeResponse;

      if (!response.ok || !data.success) {
        setPhase('idle');
        setError(
          data.error ??
            'We could not start the payment. Please try again in a moment.',
        );
        return;
      }

      setCheckoutUrl(data.authorization_url);

      // ---------------------------------------------------- popup (primary)
      let opened = false;
      try {
        opened = await openPaystackPopup({
          accessCode: data.access_code,
          reference: data.reference,
          publicKey: data.public_key,
          email: data.email,
          amount: data.amount,
          callbacks: {
            onSuccess: (result) => {
              setPhase('popup');
              onSuccess?.(result.reference);
              router.push(
                `/payment/verify?reference=${encodeURIComponent(result.reference)}`,
              );
            },
            onCancel: () => {
              // Not an error: the player just changed their mind.
              setPhase('idle');
              setError(
                'Payment window closed before you finished. Tap the button again to retry.',
              );
            },
            onError: () => {
              // The popup itself failed — use the redirect fallback.
              redirectToCheckout(data.authorization_url);
            },
          },
        });
      } catch {
        // The Paystack script could not be loaded at all.
        opened = false;
      }

      // ------------------------------------------------- redirect (fallback)
      if (!opened) {
        redirectToCheckout(data.authorization_url);
        return;
      }

      setPhase('popup');
    } catch {
      setPhase('idle');
      setError(
        'We could not reach the payment service. Check your internet connection and try again.',
      );
    }
  };

  const busy = phase === 'starting' || phase === 'redirecting';

  return (
    <div className="space-y-3">
      {/*
        Text and height are fixed by the brief: "Pay GH₵10 & Register", at least
        56px tall so it is easy to hit with a thumb.
      */}
      <button
        type="button"
        onClick={startPayment}
        disabled={busy}
        className="btn-primary min-h-[56px] text-lg"
      >
        {phase === 'starting' ? 'Opening Paystack…' : null}
        {phase === 'redirecting' ? 'Taking you to Paystack…' : null}
        {phase === 'idle' || phase === 'popup'
          ? `Pay ${amountLabel} & Register`
          : null}
      </button>

      {/* Manual fallback link — always visible, never blocked by a popup blocker. */}
      {checkoutUrl && phase !== 'redirecting' ? (
        <p className="text-center text-xs text-slate-400">
          Popup not opening?{' '}
          <a
            href={checkoutUrl}
            className="font-semibold text-pitch-400 underline"
          >
            Open the Paystack checkout page
          </a>
        </p>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
        >
          <p>{error}</p>
          <a
            href={whatsappLink(
              undefined,
              'Hi, I had a problem paying my DLS tournament entry fee.',
            )}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block min-h-tap font-semibold text-pitch-400 underline"
          >
            Contact organizer on WhatsApp
          </a>
        </div>
      ) : null}

      <p className="text-center text-xs text-slate-500">
        Pay with MTN MoMo, Vodafone Cash or AirtelTigo. Paystack handles the
        payment — we never see your PIN.
      </p>
    </div>
  );
}
