/**
 * verifyPayment(): money only ever moves a registration FORWARD.
 *
 * verifyPayment() runs for any reference anyone presents: the /payment/verify
 * page (an old tab can be reopened days later), /api/verify-payment, and the
 * webhook (Paystack retries deliveries). Two real bugs lived here:
 *
 *   - An old reference un-paid a player. /api/paystack/initialize issues a
 *     fresh reference on every "Pay" tap. Re-checking an OLDER, abandoned
 *     attempt found the row through the transaction metadata and wrote
 *     'failed' — even after the newer attempt had paid. The player lost the
 *     slot they paid for.
 *   - A re-check undid a refund. Re-checking a refunded registration's
 *     original transaction re-credited it (a MoMo refund paid by hand leaves
 *     the transaction 'success'), or overwrote it as 'failed' (a refund
 *     processed by Paystack turns the transaction 'reversed').
 *
 * The database is the in-memory fake (tests/fake-supabase.ts, which ports
 * mark_registration_paid()), and Paystack's verify endpoint is a stubbed
 * fetch.
 */

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { verifyPayment } from '../lib/paystack';
import { createFakeDb, createFakeSupabase, type FakeDb } from './fake-supabase';

process.env.PAYSTACK_SECRET_KEY = 'sk_test_verify_payment_suite';

/** GH₵10, in pesewas — the fake tournament's entry fee. */
const ENTRY_FEE = 1000;

/**
 * Kofi's registration. He tapped "Pay" twice: DLS-OLD was the first attempt,
 * DLS-NEW the second, and the row carries the newest reference — exactly as
 * /api/paystack/initialize leaves it.
 */
function kofi(
  paymentStatus: 'pending' | 'paid' | 'failed' | 'refunded',
  options: { otherPaidPlayers?: number; maxPlayers?: number } = {},
): FakeDb {
  const db = createFakeDb({
    paidCount: options.otherPaidPlayers ?? 0,
    maxPlayers: options.maxPlayers ?? 8,
    entryFee: ENTRY_FEE,
  });
  db.tables.registrations.push({
    id: 'reg-kofi',
    tournament_id: 'tournament-1',
    player_name: 'Kofi',
    phone_number: '0241234567',
    momo_number: '0241234567',
    dls_team_name: 'Accra Lions',
    paystack_reference: 'DLS-NEW',
    payment_status: paymentStatus,
    created_at: new Date(0).toISOString(),
  });
  return db;
}

/** Kofi's row as it is now. */
function row(db: FakeDb) {
  const found = db.tables.registrations.find((registration) => registration.id === 'reg-kofi');
  assert.ok(found, 'Kofi\'s registration disappeared');
  return found;
}

/**
 * Stubs Paystack's verify endpoint for the rest of the test: whatever
 * reference is asked about, Paystack answers with `paystack.status`, the full
 * entry fee in GHS, and Kofi's registration id in the metadata (as initialize
 * attaches it).
 */
function stubPaystack(t: TestContext, status: string) {
  const paystack = { status };
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const reference = decodeURIComponent(url.split('/').pop() ?? '');
    return new Response(
      JSON.stringify({
        status: true,
        message: 'Verification successful',
        data: {
          id: 1,
          status: paystack.status,
          reference,
          amount: ENTRY_FEE,
          currency: 'GHS',
          metadata: { registration_id: 'reg-kofi' },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return paystack;
}

test('re-checking an older attempt never un-pays a registration', async (t) => {
  const db = kofi('paid');
  const paystack = stubPaystack(t, 'abandoned');

  // Abandoned, failed or reversed, or a stale MoMo prompt still open on the
  // phone: none of it says anything about the newer attempt that paid.
  for (const status of ['abandoned', 'failed', 'reversed', 'ongoing']) {
    paystack.status = status;
    const result = await verifyPayment('DLS-OLD', createFakeSupabase(db));

    assert.equal(row(db).payment_status, 'paid', `"${status}" on an old attempt un-paid the slot`);
    assert.equal(row(db).paystack_reference, 'DLS-NEW');
    assert.equal(result.success, false);
    assert.equal(result.code, 'already_paid', status);
  }
});

test('an older attempt failing leaves the newer, pending attempt alone', async (t) => {
  const db = kofi('pending');
  const paystack = stubPaystack(t, 'failed');

  const result = await verifyPayment('DLS-OLD', createFakeSupabase(db));
  assert.equal(result.code, 'payment_failed');
  assert.equal(row(db).payment_status, 'pending');
  assert.equal(row(db).paystack_reference, 'DLS-NEW');

  // …so when the newer attempt lands, it confirms as normal.
  paystack.status = 'success';
  const confirmed = await verifyPayment('DLS-NEW', createFakeSupabase(db));
  assert.equal(confirmed.success, true);
  assert.equal(row(db).payment_status, 'paid');
});

test('the current attempt failing still marks the registration failed', async (t) => {
  const db = kofi('pending');
  stubPaystack(t, 'abandoned');

  const result = await verifyPayment('DLS-NEW', createFakeSupabase(db));
  assert.equal(result.code, 'payment_failed');
  assert.equal(row(db).payment_status, 'failed');
});

test('a new "Pay" tap between the read and the write is not marked failed', async (t) => {
  const db = kofi('pending');
  stubPaystack(t, 'abandoned');

  // Another request stores a newer reference just before our write lands.
  db.beforeQuery = (table, operation) => {
    if (table === 'registrations' && operation === 'update') {
      row(db).paystack_reference = 'DLS-NEWER';
    }
  };

  await verifyPayment('DLS-NEW', createFakeSupabase(db));
  assert.equal(row(db).payment_status, 'pending');
  assert.equal(row(db).paystack_reference, 'DLS-NEWER');
});

test('a MoMo prompt still in flight never marks anything failed', async (t) => {
  const db = kofi('pending');
  const paystack = stubPaystack(t, 'ongoing');

  for (const status of ['ongoing', 'pending', 'processing', 'queued', 'send_otp']) {
    paystack.status = status;
    const result = await verifyPayment('DLS-NEW', createFakeSupabase(db));
    assert.equal(result.code, 'still_pending', status);
    assert.equal(row(db).payment_status, 'pending', status);
  }
});

test('a refunded registration is never re-credited or overwritten', async (t) => {
  // A free slot, so nothing but the refund itself stands in the way.
  const db = kofi('refunded');
  const paystack = stubPaystack(t, 'success');

  // 'success': the organizer refunded the MoMo by hand, so Paystack still
  // shows the original charge as successful. 'reversed': the refund went
  // through Paystack.
  for (const status of ['success', 'reversed', 'failed']) {
    paystack.status = status;
    const result = await verifyPayment('DLS-NEW', createFakeSupabase(db));

    assert.equal(row(db).payment_status, 'refunded', `"${status}" undid the refund`);
    assert.equal(result.success, false);
    assert.equal(result.code, 'refunded', status);
  }
  assert.deepEqual(db.rpcCalls, [], 'a refunded registration must never reach mark_registration_paid()');
});

test('a successful payment claims the slot once; repeats change nothing', async (t) => {
  const db = kofi('pending');
  stubPaystack(t, 'success');

  const first = await verifyPayment('DLS-NEW', createFakeSupabase(db));
  assert.equal(first.success, true);
  assert.equal(first.player_name, 'Kofi');
  assert.equal(first.tournament_id, 'tournament-1');
  assert.equal(row(db).payment_status, 'paid');
  assert.equal(db.rpcCalls?.length, 1);

  // The webhook and the browser callback both arrive — and Paystack retries.
  const again = await verifyPayment('DLS-NEW', createFakeSupabase(db));
  assert.equal(again.success, true);
  assert.equal(row(db).payment_status, 'paid');
  assert.equal(db.rpcCalls?.length, 1, 'an already-paid row must not be claimed again');
});

test('a late success on an older attempt still confirms the slot', async (t) => {
  // The first MoMo prompt was approved after all: that money is real.
  const db = kofi('pending');
  stubPaystack(t, 'success');

  const result = await verifyPayment('DLS-OLD', createFakeSupabase(db));
  assert.equal(result.success, true);
  assert.equal(row(db).payment_status, 'paid');
  assert.equal(row(db).paystack_reference, 'DLS-OLD', 'the row records the reference that paid');
});

test('a payment after the last slot was taken is not credited', async (t) => {
  const db = kofi('pending', { otherPaidPlayers: 8, maxPlayers: 8 });
  stubPaystack(t, 'success');

  const result = await verifyPayment('DLS-NEW', createFakeSupabase(db));
  assert.equal(result.code, 'tournament_full');
  assert.equal(row(db).payment_status, 'pending');
});

test('without mark_registration_paid() the fallback confirms, within capacity', async (t) => {
  // A database that never ran the 20260924 hardening migration.
  stubPaystack(t, 'success');

  const open = kofi('pending');
  open.rpcMissing = true;
  const confirmed = await verifyPayment('DLS-NEW', createFakeSupabase(open));
  assert.equal(confirmed.success, true);
  assert.equal(row(open).payment_status, 'paid');

  const full = kofi('failed', { otherPaidPlayers: 8, maxPlayers: 8 });
  full.rpcMissing = true;
  const refused = await verifyPayment('DLS-NEW', createFakeSupabase(full));
  assert.equal(refused.code, 'tournament_full');
  assert.equal(row(full).payment_status, 'failed');
});
