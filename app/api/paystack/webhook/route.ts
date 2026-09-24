/**
 * Paystack webhook. This is the durable payment path: it records a successful
 * charge even when the customer's browser closes or never reaches our callback.
 */
import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';
import { verifyPayment } from '@/lib/paystack';
import { isValidPaystackSignature } from '@/lib/paystack-webhook';
import { drawWhenTournamentIsFull } from '@/lib/draw';
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

  // If that payment filled the tournament, draw the groups now (lib/draw.ts).
  // Paystack retries deliveries, so this runs more than once in practice; the
  // database lock inside `ensureGroupDraw()` means only one of those runs can
  // create fixtures, and the others simply confirm the groups are there.
  await drawWhenTournamentIsFull(result.tournament_id);

  // A new player was just confirmed — drop any cached HTML so the player count
  // (and the freshly drawn groups page) is current for the next visitor, even
  // when the customer's browser never came back.
  revalidatePath('/', 'page');
  if (result.tournament_id) {
    revalidatePath(`/groups/${result.tournament_id}`, 'page');
  }

  return NextResponse.json({ received: true });
}
