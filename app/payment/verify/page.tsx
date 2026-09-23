'use client';

/**
 * Payment verification page (/payment/verify?reference=xxx).
 *
 * Paystack sends the browser here after checkout (both the popup and the
 * redirect flow finish on this URL, with Paystack appending `?reference=`).
 *
 * This page is a thin client: it POSTs the reference to `/api/verify-payment`,
 * shows "Verifying payment…" while that request is in flight, and then either
 *   - redirects to /payment/success when the server confirms the money, or
 *   - shows a friendly error with a WhatsApp contact link.
 *
 * The verification itself always happens on the server, because only the server
 * holds PAYSTACK_SECRET_KEY.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { whatsappLink } from '@/lib/format';

/** What the page is doing right now. */
type Phase = 'verifying' | 'error';

/** Shape of the /api/verify-payment response. */
interface VerifyResponse {
  success: boolean;
  player_name?: string;
  error?: string;
}

/**
 * Inner component that reads the query string.
 * Wrapped in `<Suspense>` below because `useSearchParams()` needs a boundary.
 */
function VerifyPayment() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Paystack uses `reference`; older links use `trxref` for the same value.
  const reference = (
    searchParams.get('reference') ??
    searchParams.get('trxref') ??
    ''
  ).trim();

  const [phase, setPhase] = useState<Phase>('verifying');
  const [message, setMessage] = useState('');

  // Guard against React 18 running the effect twice in development.
  const started = useRef(false);

  /**
   * Asks the server to verify the reference with Paystack.
   */
  const verify = useCallback(async () => {
    setPhase('verifying');

    try {
      const response = await fetch('/api/verify-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference }),
      });

      const data = (await response.json()) as VerifyResponse;

      if (response.ok && data.success) {
        // Confirmed: hand over to the success page.
        router.replace(
          `/payment/success?reference=${encodeURIComponent(reference)}`,
        );
        return;
      }

      setMessage(
        data.error ??
          'We could not confirm that payment. If money left your MoMo wallet, message us and we will fix it.',
      );
      setPhase('error');
    } catch {
      setMessage(
        'We could not reach the server to confirm your payment. Check your internet connection and try again.',
      );
      setPhase('error');
    }
  }, [reference, router]);

  useEffect(() => {
    if (!reference) {
      setMessage(
        'That payment link did not include a reference. If you were charged, message us with your MoMo confirmation SMS.',
      );
      setPhase('error');
      return;
    }

    if (started.current) return;
    started.current = true;
    void verify();
  }, [reference, verify]);

  // ---------------------------------------------------------------- loading
  if (phase === 'verifying') {
    return (
      <div
        className="card flex flex-col items-center justify-center py-10 text-center"
        role="status"
        aria-live="polite"
      >
        {/* Simple CSS spinner — no animation library needed. */}
        <span
          aria-hidden="true"
          className="h-10 w-10 animate-spin rounded-full border-4 border-white/15 border-t-pitch-400"
        />
        <h1 className="mt-4 text-lg font-bold text-white">
          Verifying payment…
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Please keep this page open for a few seconds.
        </p>
      </div>
    );
  }

  // ------------------------------------------------------------------ error
  return (
    <div className="space-y-4">
      <div className="card border-red-500/40 bg-red-500/10">
        <h1 className="text-lg font-bold text-red-200">
          Payment not confirmed
        </h1>
        <p className="mt-1 text-sm text-red-100">{message}</p>
        {reference ? (
          <p className="mt-2 font-mono text-xs text-red-200/80">
            Reference: {reference}
          </p>
        ) : null}
      </div>

      <button type="button" onClick={verify} className="btn-secondary">
        Try verifying again
      </button>

      <a
        href={whatsappLink(
          undefined,
          `Hi, I had a payment problem for the DLS tournament.${
            reference ? ` Reference: ${reference}` : ''
          }`,
        )}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-primary"
      >
        Contact organizer on WhatsApp
      </a>

      <Link href="/" className="btn-secondary">
        Back to the tournament
      </Link>
    </div>
  );
}

/**
 * Page wrapper. The Suspense boundary is required because the inner component
 * reads the query string with `useSearchParams()`.
 */
export default function PaymentVerifyPage() {
  return (
    <Suspense
      fallback={
        <div className="card py-10 text-center" role="status">
          <span
            aria-hidden="true"
            className="mx-auto block h-10 w-10 animate-spin rounded-full border-4 border-white/15 border-t-pitch-400"
          />
          <h1 className="mt-4 text-lg font-bold text-white">
            Verifying payment…
          </h1>
        </div>
      }
    >
      <VerifyPayment />
    </Suspense>
  );
}
