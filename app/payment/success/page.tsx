/**
 * Payment success page (/payment/success?reference=xxx).
 *
 * Reached after /payment/verify (or /api/verify-payment) has confirmed the
 * money with Paystack and the registration has been marked 'paid'.
 *
 * It shows:
 * - a big green checkmark and "Payment Successful! 🎉"
 * - the player's name and the tournament they entered
 * - "You will receive your group fixtures via WhatsApp before [match_deadline]"
 * - a button to join the players' WhatsApp group
 * - a WhatsApp share button: "Challenge a friend — join this tournament!"
 *
 * If the reference is unknown, or the payment has not been confirmed yet, the
 * page says so plainly and offers a retry instead of pretending all is well.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase';
import { formatCedis } from '@/lib/calculations';
import {
  formatDateTime,
  siteUrl,
  whatsappGroupLink,
  whatsappLink,
} from '@/lib/format';
import type { Registration, Tournament } from '@/types';

/** Always read the live payment state — never cache a confirmation page. */
export const dynamic = 'force-dynamic';

/** Page metadata. */
export const metadata: Metadata = {
  title: 'Payment Successful',
};

/** Props passed by Next.js. */
interface SuccessPageProps {
  searchParams: {
    /** The Paystack reference that was verified. */
    reference?: string;
  };
}

/**
 * Renders the confirmation page.
 *
 * @param props.searchParams Contains the payment reference.
 */
export default async function PaymentSuccessPage({
  searchParams,
}: SuccessPageProps) {
  const reference = (searchParams.reference ?? '').trim();

  // Load the registration and its tournament (server-side, display fields only).
  let registration: Registration | null = null;
  let tournament: Tournament | null = null;

  if (reference && isSupabaseConfigured()) {
    try {
      const supabase = supabaseAdmin();

      const { data: registrationRow } = await supabase
        .from('registrations')
        .select('*')
        .eq('paystack_reference', reference)
        .maybeSingle();

      registration = (registrationRow as Registration) ?? null;

      if (registration) {
        const { data: tournamentRow } = await supabase
          .from('tournaments')
          .select('*')
          .eq('id', registration.tournament_id)
          .maybeSingle();

        tournament = (tournamentRow as Tournament) ?? null;
      }
    } catch (error) {
      console.error('[payment/success]', error);
    }
  }

  // ---------------------------------------------- unknown / missing reference
  if (!registration) {
    return (
      <div className="space-y-4">
        <div className="card border-amber-500/40 bg-amber-500/10">
          <h1 className="text-lg font-bold text-amber-200">
            We could not find that registration
          </h1>
          <p className="mt-1 text-sm text-amber-100">
            If you have just paid, wait a moment and open the link from your
            payment confirmation again — or message the organizer with your
            reference and we will sort it out.
          </p>
        </div>

        <a
          href={whatsappLink(
            undefined,
            'Hi, I paid but I cannot see my DLS tournament confirmation.',
          )}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-primary"
        >
          Contact organizer on WhatsApp
        </a>

        {/* Plain <a> (not <Link>): a full document load bypasses the client
            router cache, so the player always sees the fresh player count. */}
        <a href="/" className="btn-secondary">
          Back to the tournament
        </a>
      </div>
    );
  }

  // ------------------------------------------- payment not confirmed (yet)
  if (registration.payment_status !== 'paid') {
    return (
      <div className="space-y-4">
        <div className="card">
          <h1 className="text-lg font-bold text-white">
            Payment still being confirmed
          </h1>
          <p className="mt-1 text-sm text-slate-300">
            We have your registration for{' '}
            {tournament?.title ?? 'the tournament'}, but Paystack has not
            confirmed the payment yet. If you completed the MoMo prompt, give it
            a minute and check again.
          </p>
        </div>

        <Link
          href={`/payment/verify?reference=${encodeURIComponent(reference)}`}
          className="btn-primary"
        >
          Check payment again
        </Link>

        {/* Plain <a> (not <Link>): a full document load bypasses the client
            router cache, so the player always sees the fresh player count. */}
        <a href="/" className="btn-secondary">
          Back to the tournament
        </a>
      </div>
    );
  }

  // --------------------------------------------------------- all confirmed
  const matchDeadlineLabel = tournament?.match_deadline
    ? formatDateTime(tournament.match_deadline)
    : 'the match deadline';

  /** Share text that tells a friend everything they need to join. */
  const shareText = `I just entered ${
    tournament?.title ?? 'the DLS tournament'
  } on DLS Tournament GH 🎮 Entry is ${
    tournament ? formatCedis(tournament.entry_fee) : ''
  }. Challenge me: ${siteUrl()}`;

  return (
    <div className="space-y-6">
      {/* ========================== CONFIRMATION ========================= */}
      <section className="card border-pitch-500/50 bg-pitch-500/10 text-center">
        <p className="text-5xl" aria-hidden="true">
          ✅
        </p>
        <h1 className="mt-2 text-2xl font-extrabold text-white">
          Payment Successful! <span aria-hidden="true">🎉</span>
        </h1>
        <p className="mt-2 text-sm text-slate-200">
          You’re in the tournament,{' '}
          <strong className="text-white">{registration.player_name}</strong>.
        </p>
      </section>

      {/* ============================ DETAILS ============================ */}
      <section className="card">
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Player</dt>
            <dd className="text-right font-medium text-white">
              {registration.player_name}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Tournament</dt>
            <dd className="text-right font-medium text-white">
              {tournament?.title ?? 'DLS Tournament'}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">DLS team</dt>
            <dd className="text-right font-medium text-white">
              {registration.dls_team_name}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Entry fee</dt>
            <dd className="text-right font-medium text-white">
              {tournament ? formatCedis(tournament.entry_fee) : '—'} · paid
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Reference</dt>
            <dd className="text-right font-mono text-xs text-slate-300">
              {reference}
            </dd>
          </div>
        </dl>

        {/* The exact wording required by the brief. */}
        <p className="mt-4 rounded-xl bg-white/5 p-3 text-sm text-slate-200">
          You will receive your group fixtures via WhatsApp before{' '}
          <strong className="text-white">{matchDeadlineLabel}</strong>.
        </p>
      </section>

      {/* =========================== NEXT STEPS ========================== */}
      <section className="space-y-3">
        <a
          href={whatsappGroupLink()}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-primary"
        >
          Join the tournament WhatsApp group
        </a>

        <a
          href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary"
        >
          Challenge a friend — join this tournament!
        </a>

        {/* Plain <a> (not <Link>): a full document load bypasses the client
            router cache, so the player always sees the updated player count
            instead of whatever the router has cached from an earlier visit. */}
        <a href="/" className="btn-secondary">
          Back to the tournament page
        </a>
      </section>
    </div>
  );
}
