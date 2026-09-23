/**
 * The prize pool card on the landing page.
 *
 * Every number comes from `calculatePrizes()` in lib/calculations.ts, so the
 * card can never disagree with the published rules:
 *   organizer keeps 15% of the total pot,
 *   the rest is split 70% (1st place) / 30% (2nd place).
 */

import type { PrizeBreakdownProps } from '@/types';
import { formatCedis } from '@/lib/calculations';

/**
 * Renders the prize pool, the two prizes, and the supporting maths.
 *
 * @param props.prizes The calculated breakdown, in pesewas.
 * @param props.isProjected True when the tournament is not full yet, so the
 *                           figures are labelled "if full".
 */
export default function PrizeBreakdown({
  prizes,
  isProjected = false,
}: PrizeBreakdownProps) {
  return (
    <div className="card">
      {/* Total prize pool — the headline number. */}
      <div className="rounded-xl border border-pitch-500/40 bg-pitch-500/10 px-4 py-3">
        <p className="text-sm font-semibold text-pitch-400">
          💰 Total Prize Pool
        </p>
        <p className="text-2xl font-extrabold text-white">
          {formatCedis(prizes.prizePot)}
        </p>
        {isProjected ? (
          <p className="mt-0.5 text-xs text-pitch-200/80">
            If all {prizes.totalPlayers} player slots are filled
          </p>
        ) : null}
      </div>

      {/* The two payouts. */}
      <dl className="mt-3 space-y-2">
        <div className="flex items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2.5">
          <dt className="text-sm font-semibold text-white">🥇 1st Place</dt>
          <dd className="text-lg font-bold text-pitch-400">
            {formatCedis(prizes.winnerPrize)}
          </dd>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2.5">
          <dt className="text-sm font-semibold text-white">🥈 2nd Place</dt>
          <dd className="text-lg font-bold text-white">
            {formatCedis(prizes.runnerUpPrize)}
          </dd>
        </div>
      </dl>

      {/* The supporting maths, so players can check it themselves. */}
      <div className="mt-3 space-y-1 border-t border-white/10 pt-3 text-xs text-slate-400">
        <div className="flex justify-between gap-3">
          <span>Total collected ({prizes.totalPlayers} players)</span>
          <span className="tabular-nums">{formatCedis(prizes.totalPot)}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span>Organizer cut (15%)</span>
          <span className="tabular-nums">
            {formatCedis(prizes.organizerShare)}
          </span>
        </div>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Prizes are paid by MoMo within 1 hour of the Grand Final. All amounts in
        Ghana cedis.
      </p>
    </div>
  );
}
