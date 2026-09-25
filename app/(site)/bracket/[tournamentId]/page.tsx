/**
 * Knockout bracket page (/bracket/[tournamentId])   (MODULE 3)
 *
 * Visible as soon as the bracket exists (tournament status `bracket_drawn`).
 * Before that it shows "Knockout bracket not drawn yet — check back soon".
 *
 * Layout: round by round, with every match as a full-width card stacked
 * vertically — deliberately NOT a horizontal bracket diagram, which is
 * unreadable on a phone. `AutoRefresh` re-renders the page every 60 seconds, so
 * a result your opponent just submitted appears on its own.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import AutoRefresh from '@/components/AutoRefresh';
import BracketCard from '@/components/BracketCard';
import { getBracketMatches, getBracketView, getTournamentById } from '@/lib/data';
import { formatDateTime, whatsappLink } from '@/lib/format';
import { findChampionId, knockoutRoundLabel } from '@/lib/bracket';

/** Results change during match days — always render fresh. */
export const dynamic = 'force-dynamic';

/** Props passed by Next.js. */
interface BracketPageProps {
  params: {
    /** The tournament's UUID. */
    tournamentId: string;
  };
}

/** Simple UUID shape check so we never query the database with junk. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Page metadata.
 *
 * @param props.params Route parameters.
 */
export async function generateMetadata({
  params,
}: BracketPageProps): Promise<Metadata> {
  const tournament = UUID_PATTERN.test(params.tournamentId)
    ? await getTournamentById(params.tournamentId)
    : null;

  return {
    title: tournament
      ? `Knockout Bracket — ${tournament.title}`
      : 'Knockout Bracket',
  };
}

/**
 * Renders the bracket.
 *
 * @param props.params Contains the tournament id.
 */
export default async function BracketPage({ params }: BracketPageProps) {
  const { tournamentId } = params;

  if (!UUID_PATTERN.test(tournamentId)) {
    return <NotDrawnYet reason="That tournament link is not valid." />;
  }

  const tournament = await getTournamentById(tournamentId);

  if (!tournament) {
    return <NotDrawnYet reason="That tournament could not be found." />;
  }

  const rawMatches = await getBracketMatches(tournamentId);

  if (rawMatches.length === 0) {
    return <NotDrawnYet tournamentTitle={tournament.title} />;
  }

  const matches = await getBracketView(tournamentId, rawMatches);

  const totalRounds = Math.max(...matches.map((match) => match.round));
  const rounds = Array.from(new Set(matches.map((match) => match.round))).sort(
    (a, b) => a - b,
  );

  // Champion: the winner of the final round, once that match is confirmed.
  const championId = findChampionId(rawMatches);
  const champion = championId
    ? matches.find((match) => match.winner_id === championId)
    : undefined;

  return (
    <div className="space-y-5">
      <AutoRefresh intervalSeconds={60} />

      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-pitch-400">
          Knockout stage
        </p>
        <h1 className="text-xl font-bold text-white">{tournament.title}</h1>
        <p className="text-sm text-slate-400">
          Single elimination · no draws · extra time + penalties
        </p>
        <p className="text-xs text-slate-500">
          Match deadline: {formatDateTime(tournament.match_deadline)} · this page
          updates itself every 60 seconds.
        </p>
      </header>

      {/* Champion banner — only after the Grand Final is confirmed. */}
      {champion?.winner_name ? (
        <section className="card border-amber-400/50 bg-amber-400/10 text-center">
          <p className="text-4xl" aria-hidden="true">
            🏆
          </p>
          <h2 className="mt-1 text-xs font-semibold uppercase tracking-wide text-amber-200">
            Champion
          </h2>
          <p className="text-2xl font-extrabold text-white">
            {champion.winner_name}
          </p>
          <p className="mt-1 text-sm text-amber-100">
            {champion.player_a_name === champion.winner_name
              ? champion.player_a_team
              : champion.player_b_team}
          </p>
          <p className="mt-2 text-xs text-amber-200/80">
            Prizes are paid by MoMo within 1 hour of the Grand Final.
          </p>
        </section>
      ) : null}

      {/* One section per round, newest match-ups last. */}
      {rounds.map((round) => {
        const roundMatches = matches.filter((match) => match.round === round);
        const label = knockoutRoundLabel(round, totalRounds);

        return (
          <section key={round} className="space-y-3">
            <h2 className="text-lg font-bold text-white">
              {label === 'Grand Final' ? 'Grand Final 🏆' : `${label}s`}
            </h2>

            <div className="space-y-3">
              {roundMatches.map((match) => (
                <BracketCard key={match.id} match={match} />
              ))}
            </div>
          </section>
        );
      })}

      <section className="space-y-3">
        <Link href="/submit-result" className="btn-primary">
          Submit a knockout result
        </Link>

        <Link
          href={`/groups/${tournament.id}`}
          className="btn-secondary"
        >
          View group standings
        </Link>

        <a
          href={whatsappLink(
            undefined,
            `Hi, I have a question about the knockout stage of ${tournament.title}.`,
          )}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary"
        >
          Report a problem on WhatsApp
        </a>
      </section>
    </div>
  );
}

/**
 * Friendly placeholder shown when the bracket is not available yet.
 *
 * @param props.reason Optional explanation (bad link / unknown tournament).
 * @param props.tournamentTitle Optional tournament name for a warmer message.
 */
function NotDrawnYet({
  reason,
  tournamentTitle,
}: {
  reason?: string;
  tournamentTitle?: string;
}) {
  return (
    <div className="space-y-4">
      <div className="card border-amber-500/40 bg-amber-500/10">
        <h1 className="text-lg font-bold text-amber-200">
          Knockout bracket not drawn yet — check back soon
        </h1>
        <p className="mt-1 text-sm text-amber-100">
          {reason ??
            `The knockout draw for ${
              tournamentTitle ?? 'this tournament'
            } happens once every group match is finished. Check back then.`}
        </p>
      </div>

      <Link href="/" className="btn-secondary">
        Back to the tournament
      </Link>
    </div>
  );
}
