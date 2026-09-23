/**
 * Landing page (/).
 *
 * Section order is fixed by the Module 1 brief:
 *   1. Hero
 *   2. Tournament info card (live player count + countdown)
 *   3. Prize breakdown
 *   4. Registration form (+ payment)
 *   5. Rules (collapsible)
 *   6. Footer lives in app/layout.tsx (WhatsApp contact link only)
 *
 * Everything is rendered on the server, so the page is already useful on a slow
 * phone while the JavaScript is still downloading.
 */

import Link from 'next/link';
import CountdownTimer from '@/components/CountdownTimer';
import PrizeBreakdown from '@/components/PrizeBreakdown';
import RegistrationForm from '@/components/RegistrationForm';
import { calculatePrizes, formatCedis } from '@/lib/calculations';
import { formatDateTime } from '@/lib/format';
import { getActiveTournament, getRegistrationCounts } from '@/lib/data';
import { isSupabaseConfigured } from '@/lib/supabase';

/** Player counts and deadlines change constantly — never cache this page. */
export const dynamic = 'force-dynamic';

/**
 * The tournament rules, in the order they are published to players.
 * Grouped so the numbered list stays readable on a phone.
 */
const RULES: Array<{ title: string; items: string[] }> = [
  {
    title: 'Match Setup',
    items: [
      'Both players must have completed 6 Career Mode matches in DLS to unlock Friend Match.',
      'Player A (the higher seed) generates the Friend Match code and sends it to Player B via WhatsApp.',
      'The match must be completed within the time window shown on the bracket.',
    ],
  },
  {
    title: 'Result Submission',
    items: [
      'BOTH players must submit a screenshot of the final scoreboard.',
      'Submit your result on the Submit Result page within 1 hour of the match ending.',
      'Matching screenshots = the result is confirmed automatically.',
      'Conflicting screenshots = the match is marked as DISPUTED.',
    ],
  },
  {
    title: 'Disputes',
    items: [
      'Disputed matches are reviewed by the organizer within 24 hours.',
      'The organizer’s decision is final.',
      'Deliberate disconnection = automatic loss.',
    ],
  },
  {
    title: 'No-Shows',
    items: [
      'No response within 2 hours = screenshot the chat as evidence and submit it.',
      'No-shows receive a walkover loss.',
    ],
  },
  {
    title: 'Group Stage',
    items: [
      'Draws ARE allowed in the group stage.',
      'Win = 3 points, Draw = 1 point, Loss = 0 points.',
      'The top 2 players from each group advance to the knockout stage.',
      'Tiebreakers: Goal Difference → Goals Scored → Head-to-Head → Penalty Shootout.',
    ],
  },
  {
    title: 'Knockout Stage',
    items: [
      'NO draws in the knockout stage.',
      'Extra time and penalties if the match is level after full time.',
      'No 3rd place match.',
    ],
  },
  {
    title: 'Prize Payout',
    items: [
      'Prizes are paid via MoMo within 1 hour of tournament completion.',
      'The winner receives 70% of the prize pool.',
      'The runner-up receives 30% of the prize pool.',
      'The organizer retains 15% of the total pot.',
    ],
  },
];

/**
 * Renders the landing page.
 */
export default async function HomePage() {
  const tournament = await getActiveTournament();

  // ------------------------------------------------------ no tournament yet
  // Shown when the environment is not set up yet, or when setup.sql has not
  // created a tournament, or when every tournament is finished.
  if (!tournament) {
    return (
      <div className="space-y-6">
        <section className="text-center">
          <h1 className="text-3xl font-extrabold tracking-tight">
            DLS Tournament GH <span aria-hidden="true">🎮</span>
          </h1>
          <p className="mt-1 text-sm text-slate-300">
            Ghana’s #1 DLS Tournament Platform
          </p>
        </section>

        {/* Setup notice: only ever shown to the organizer, because it can only
            appear while the environment variables are missing. It disappears by
            itself as soon as .env.local is filled in and a tournament exists. */}
        {!isSupabaseConfigured() ? (
          <section className="card border-amber-500/40 bg-amber-500/10">
            <h2 className="text-base font-semibold text-amber-200">
              Setup needed — no database connected
            </h2>
            <ol className="mt-2 space-y-2 text-sm text-amber-100">
              <li>
                <strong>1.</strong> Paste <code>setup.sql</code> into Supabase →
                SQL Editor → Run.
              </li>
              <li>
                <strong>2.</strong> Copy <code>.env.example</code> to{' '}
                <code>.env.local</code> and fill in your Supabase and Paystack
                keys.
              </li>
              <li>
                <strong>3.</strong> Restart the dev server and reload this page.
              </li>
            </ol>
            <p className="mt-3 text-xs text-amber-200/80">
              Full instructions are in README.md and .env.example.
            </p>
          </section>
        ) : (
          <section className="card border-amber-500/40 bg-amber-500/10">
            <h2 className="text-base font-semibold text-amber-200">
              No tournament published yet
            </h2>
            <p className="mt-1 text-sm text-amber-100">
              The next DLS tournament is being set up. The organizer will post it
              here soon — the WhatsApp link below is always open.
            </p>
          </section>
        )}
      </div>
    );
  }

  // ------------------------------------------------------- live tournament
  const counts = await getRegistrationCounts(tournament.id);
  const spotsLeft = Math.max(0, tournament.max_players - counts.paid);
  const deadlinePassed =
    new Date(tournament.registration_deadline).getTime() < Date.now();
  const isOpen = tournament.status === 'open' && !deadlinePassed;
  const isFull = counts.paid >= tournament.max_players;

  // Prizes are calculated for a FULL tournament (the guaranteed maximum).
  const prizes = calculatePrizes(tournament.max_players, tournament.entry_fee);

  return (
    <div className="space-y-8">
      {/* ========================= 1. HERO ============================== */}
      <section aria-labelledby="hero-heading" className="text-center">
        <h1
          id="hero-heading"
          className="text-3xl font-extrabold tracking-tight"
        >
          DLS Tournament GH <span aria-hidden="true">🎮</span>
        </h1>
        <p className="mt-1 text-sm font-medium text-pitch-400">
          Ghana’s #1 DLS Tournament Platform
        </p>
      </section>

      {/* ================== 2. TOURNAMENT INFO CARD ====================== */}
      <section aria-labelledby="tournament-heading" className="card">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-pitch-400">
              Next tournament
            </p>
            <h2
              id="tournament-heading"
              className="truncate text-xl font-bold text-white"
            >
              {tournament.title}
            </h2>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Entry fee
            </p>
            <p className="text-xl font-bold text-white">
              {formatCedis(tournament.entry_fee)}
            </p>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl bg-white/5 px-3 py-2">
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Players
            </dt>
            <dd className="font-semibold text-white">
              {counts.paid} / {tournament.max_players} registered
            </dd>
          </div>
          <div className="rounded-xl bg-white/5 px-3 py-2">
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Slots left
            </dt>
            <dd className="font-semibold text-white">{spotsLeft}</dd>
          </div>
        </dl>

        <div className="mt-4">
          <CountdownTimer
            targetDate={tournament.registration_deadline}
            label={
              deadlinePassed ? 'Registration closed' : 'Registration closes in'
            }
          />
        </div>

        <p className="mt-2 text-xs text-slate-500">
          Deadline: {formatDateTime(tournament.registration_deadline)}
        </p>

        {/* Smooth scroll to the form (see `scroll-behavior: smooth` in globals.css). */}
        <a href="#register" className="btn-primary mt-4">
          Register Now
        </a>
      </section>

      {/* ==================== 3. PRIZE BREAKDOWN ========================= */}
      <section aria-labelledby="prizes-heading" className="space-y-3">
        <h2 id="prizes-heading" className="text-lg font-bold text-white">
          Prize Pool
        </h2>
        <PrizeBreakdown prizes={prizes} isProjected />
      </section>

      {/* ====================== 4. REGISTRATION ========================== */}
      <section
        id="register"
        aria-labelledby="register-heading"
        className="scroll-mt-20 space-y-3"
      >
        <h2 id="register-heading" className="text-lg font-bold text-white">
          Register for {tournament.title}
        </h2>
        <RegistrationForm
          tournamentId={tournament.id}
          entryFeeLabel={formatCedis(tournament.entry_fee)}
          isOpen={isOpen}
          isFull={isFull}
          spotsLeft={spotsLeft}
        />
      </section>

      {/* ============ PLAYER LINKS (Module 2 pages) ====================== */}
      <section aria-labelledby="links-heading" className="space-y-3">
        <h2 id="links-heading" className="text-lg font-bold text-white">
          Group Stage
        </h2>
        <Link href={`/groups/${tournament.id}`} className="btn-secondary">
          View group standings &amp; fixtures
        </Link>
        <Link href={`/submit-result?tournament=${tournament.id}`} className="btn-secondary">
          Submit a match result
        </Link>
        <p className="text-xs text-slate-500">
          Standings update automatically after every confirmed result. Once
          every group match is played, the organizer draws the knockout bracket.
        </p>
      </section>

      {/* ========================= 5. RULES ============================== */}
      <section aria-labelledby="rules-heading" className="space-y-3">
        <h2 id="rules-heading" className="text-lg font-bold text-white">
          Tournament Rules
        </h2>

        {/* Native <details> = collapsible on mobile with zero JavaScript, and
            it still works with keyboard and screen readers. The first section
            is open by default so the key rules are visible immediately. */}
        <div className="space-y-2">
          {RULES.map((section, index) => (
            <details
              key={section.title}
              open={index === 0}
              className="card p-0 [&[open]]:pb-4"
            >
              <summary className="flex min-h-tap cursor-pointer list-none items-center justify-between gap-2 px-4 py-3">
                <span className="text-base font-semibold text-pitch-400">
                  {section.title}
                </span>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-xs text-slate-400"
                >
                  Show / hide
                </span>
              </summary>

              <ul className="space-y-2 px-4">
                {section.items.map((item) => (
                  <li
                    key={item}
                    className="flex gap-2 text-sm leading-relaxed text-slate-300"
                  >
                    <span aria-hidden="true" className="text-pitch-500">
                      •
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>

        <p className="text-sm text-slate-400">
          Format: groups of 4 → Semifinals → Grand Final (no 3rd place match).
          Match deadline: {formatDateTime(tournament.match_deadline)}.
        </p>
      </section>
    </div>
  );
}
