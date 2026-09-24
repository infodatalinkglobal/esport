/**
 * Paystack webhook. This is the durable payment path: it records a successful
 * charge even when the customer's browser closes or never reaches our callback.
 */
import { NextResponse } from 'next/server';
import { verifyPayment } from '@/lib/paystack';
import { isValidPaystackSignature } from '@/lib/paystack-webhook';
import { isSupabaseConfigured } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type PaystackEvent = {
  event?: string;
  data?: { reference?: string };
};

export async function POST(request: Request) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey || !isSupabaseConfigured()) {
    console.error('[paystack.webhook] server is not configured');
    return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  }

  // Do not call request.json(): the signature covers these exact bytes.
  const rawBody = await request.text();
  if (
    !isValidPaystackSignature(
      rawBody,
      request.headers.get('x-paystack-signature'),
      secretKey,
    )
  ) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: PaystackEvent;
  try {
    payload = JSON.parse(rawBody) as PaystackEvent;
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  if (payload.event !== 'charge.success') {
    return NextResponse.json({ received: true });
  }

  const reference = payload.data?.reference?.trim();
  if (!reference) {
    return NextResponse.json({ error: 'Missing reference' }, { status: 400 });
  }

  // Never trust the event body alone. Re-fetch from Paystack and use the same
  // idempotent verification path as the browser callback.
  const result = await verifyPayment(reference);
  if (!result.success) {
    console.error('[paystack.webhook] verification failed', reference, result.error);
    // A non-2xx response asks Paystack to retry delivery.
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
