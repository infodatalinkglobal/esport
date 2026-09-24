/**
 * Server-side Paystack callback. Verification no longer depends on hydration or
 * browser JavaScript, so a slow/closed browser cannot leave a paid player at a
 * blank page. The signed webhook is the independent durable fallback.
 */
import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { verifyPayment } from '@/lib/paystack';
import { whatsappLink } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: { reference?: string; trxref?: string };
}

export default async function PaymentVerifyPage({ searchParams }: Props) {
  const reference = (searchParams.reference ?? searchParams.trxref ?? '').trim();
  let message =
    'That payment link did not include a reference. If you were charged, message us with your MoMo confirmation SMS.';

  if (reference) {
    const result = await verifyPayment(reference);
    if (result.success) {
      // A new player was just confirmed — drop any cached homepage HTML so
      // the player count is current for the next visitor (including the
      // player returning from the success page).
      revalidatePath('/', 'page');
      redirect(`/payment/success?reference=${encodeURIComponent(reference)}`);
    }
    message =
      result.error ??
      'We could not confirm that payment. If money left your wallet, contact the organizer. Do not pay again.';
  }

  return (
    <div className="space-y-4">
      <div className="card border-amber-500/40 bg-amber-500/10">
        <h1 className="text-lg font-bold text-amber-200">Payment needs attention</h1>
        <p className="mt-1 text-sm text-amber-100">{message}</p>
        <p className="mt-3 text-sm font-bold text-white">Do not initiate another payment.</p>
        {reference ? <p className="mt-2 font-mono text-xs">Reference: {reference}</p> : null}
      </div>
      {reference ? (
        <a href={`/payment/verify?reference=${encodeURIComponent(reference)}`} className="btn-secondary">
          Check payment again
        </a>
      ) : null}
      <a
        href={whatsappLink(undefined, `Hi, I paid for the DLS tournament but confirmation failed.${reference ? ` Reference: ${reference}` : ''}`)}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-primary"
      >
        Contact organizer on WhatsApp
      </a>
      <Link href="/" className="btn-secondary">Back to the tournament</Link>
    </div>
  );
}
