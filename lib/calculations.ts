/**
 * Prize pool maths.
 *
 * Every amount is handled in PESEWAS (integers) because Paystack charges in
 * pesewas — working in whole numbers means a payout can never be off by a
 * fraction of a pesewa. `Math.floor` is used at each split so the organizer
 * never accidentally promises more money than was collected.
 */

import type { PrizeBreakdown } from '@/types';

/** The share of the prize pot that goes to the winner (70%). */
export const WINNER_SHARE = 0.7;

/** The share of the prize pot that goes to the runner-up (30%). */
export const RUNNER_UP_SHARE = 0.3;

/**
 * Entry fee in pesewas, read from the environment.
 * `NEXT_PUBLIC_TOURNAMENT_ENTRY_FEE=1000` means GH₵10.
 * Falls back to 1000 so the site still renders before the env vars are set.
 */
export const ENTRY_FEE_PESEWAS = Number(
  process.env.NEXT_PUBLIC_TOURNAMENT_ENTRY_FEE ?? 1000,
);

/**
 * Organizer's cut of the total pot, as a percentage.
 * `NEXT_PUBLIC_ORGANIZER_CUT_PERCENT=15` means the organizer keeps 15%.
 */
export const ORGANIZER_CUT_PERCENT = Number(
  process.env.NEXT_PUBLIC_ORGANIZER_CUT_PERCENT ?? 15,
);

/**
 * Formats an integer number of pesewas as a Ghana cedi string.
 *
 * @param pesewas Amount in pesewas, e.g. 10570.
 * @returns A display string such as "GH₵105.70".
 *
 * @example
 * formatCedis(1000);  // 'GH₵10.00'
 * formatCedis(0);     // 'GH₵0.00'
 */
export function formatCedis(pesewas: number): string {
  const safe = Number.isFinite(pesewas) ? pesewas : 0;
  return `GH₵${(safe / 100).toFixed(2)}`;
}

/**
 * Splits a total pot into the organizer share and the two prizes.
 *
 * Rules (from the tournament rules):
 * - Organizer retains 15% of the total pot.
 * - The remaining prize pot is split 70% winner / 30% runner-up.
 *
 * @param totalPlayers How many players the pot is based on.
 * @param entryFee Entry fee per player, in pesewas.
 * @param organizerCut Organizer's percentage cut (15 means 15%).
 * @returns The full {@link PrizeBreakdown}, all values in pesewas.
 *
 * @example
 * // 8 players x GH₵10 = GH₵80 pot
 * calculatePrizes(8, 1000, 15);
 * // => { totalPot: 8000, organizerShare: 1200, prizePot: 6800,
 * //      winnerPrize: 4760, runnerUpPrize: 2040, totalPlayers: 8 }
 */
export function calculatePrizes(
  totalPlayers: number,
  entryFee: number = ENTRY_FEE_PESEWAS,
  organizerCut: number = ORGANIZER_CUT_PERCENT,
): PrizeBreakdown {
  // Guard against negative or non-numeric input coming from the database.
  const players = Math.max(0, Math.floor(totalPlayers) || 0);
  const fee = Math.max(0, Math.floor(entryFee) || 0);

  const totalPot = players * fee;
  const organizerShare = Math.floor(totalPot * (organizerCut / 100));
  const prizePot = totalPot - organizerShare;
  const winnerPrize = Math.floor(prizePot * WINNER_SHARE);
  const runnerUpPrize = Math.floor(prizePot * RUNNER_UP_SHARE);

  return {
    totalPlayers: players,
    totalPot,
    organizerShare,
    prizePot,
    winnerPrize,
    runnerUpPrize,
  };
}
