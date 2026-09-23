/**
 * Result submission page (/submit-result)   (MODULE 2)
 *
 * The page loads the tournament's open fixtures on the server and hands them to
 * the form, so the browser never sees a phone number:
 *
 * - Group matches: fixtures still waiting for a result ('pending').
 * - Knockout matches: none yet — Module 3 fills this in.
 *
 * "Tournament ID (dropdown or URL param)": the tournament comes from the
 * `?tournament=<uuid>` link the organizer shares, and falls back to the active
 * tournament, so players never have to pick one.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import ResultSubmissionForm from '@/components/ResultSubmissionForm';
import type { MatchOption } from '@/types';
import {
  getActiveTournament,
  getGroupMatches,
  getPlayerMap,
  getTournamentById,
} from '@/lib/data';
import { whatsappLink } from '@/lib/format';

/** Match states change constantly — always render fresh. */
export const dynamic = 'force-dynamic';

/** Page metadata. */
export const metadata: Metadata = {
  title: 'Submit Match Result',
  description:
    'Submit your Dream League Soccer result with a screenshot of the final scoreboard.',
};

/** Props passed by Next.js. */
interface SubmitResultPageProps {
  searchParams: {
    /** Optional tournament id; otherwise the active tournament is used. */
    tournament?: string;
  };
}

/**
 * Renders the result submission page.
 *
 * @param props.searchParams May contain the tournament id.
 */
export default async function SubmitResultPage({
  searchParams,
}: SubmitResultPageProps) {
  // Which tournament? The link parameter wins, then the active tournament.
  const requestedId = searchParams.tournament?.trim();
  const tournament = requestedId
    ? await getTournamentById(requestedId)
    : await getActiveTournament();

  // No tournament at all.
  if (!tournament) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-white">Submit a match result</h1>

        <div className="card border-amber-500/40 bg-amber-500/10">
          <p className="text-sm text-amber-100">
            There is no active tournament yet. Once the groups are drawn you will
            be able to report your results here.
          </p>
          <a
            href={whatsappLink(
              undefined,
              'Hi! When does the next DLS tournament start?',
            )}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary mt-3"
          >
            Ask the organizer on WhatsApp
          </a>
        </div>

        <Link href="/" className="btn-secondary">
          Back to the tournament
        </Link>
      </div>
    );
  }

  const [groupMatches, players] = await Promise.all([
    getGroupMatches(tournament.id),
    getPlayerMap(tournament.id),
  ]);

  // Only fixtures that are still waiting for a result can be reported, and the
  // dropdown shows both names so nobody picks the wrong one.
  const groupOptions: MatchOption[] = groupMatches
    .filter((match) => match.status === 'pending')
    .map((match) => ({
      id: match.id,
      label: `Match ${match.match_number}: ${
        players[match.player_a_id]?.player_name ?? 'Player A'
      } vs ${players[match.player_b_id]?.player_name ?? 'Player B'}`,
    }));

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-bold text-white">Submit your result</h1>
        <p className="text-sm text-slate-400">
          {tournament.title} · both players must submit a screenshot of the final
          scoreboard within 1 hour of the match ending.
        </p>
      </header>

      <div className="card text-sm text-slate-300">
        <p className="font-semibold text-white">Before you submit</p>
        <ul className="mt-1 space-y-1 text-xs text-slate-400">
          <li>• Use the WhatsApp number you registered with.</li>
          <li>
            • Enter your score and your opponent&rsquo;s score exactly as they
            appear on the final scoreboard. Draws are allowed in the group stage.
          </li>
          <li>
            • Matching submissions confirm the result automatically; conflicting
            submissions mark the match DISPUTED for the organizer to review
            within 24 hours.
          </li>
        </ul>
      </div>

      {/* Module 3 will pass the real knockout fixtures into this component. */}
      <ResultSubmissionForm
        tournamentId={tournament.id}
        groupMatches={groupOptions}
        knockoutMatches={[]}
      />

      <Link href={`/groups/${tournament.id}`} className="btn-secondary">
        View group standings &amp; fixtures
      </Link>
    </div>
  );
}
