/**
 * Group standings page (/groups/[tournamentId])   (MODULE 2)
 *
 * Shows every group's league table followed by that group's fixtures.
 *
 * Visibility: the tables only exist once the organizer has run the draw, so
 * before that the page shows "Groups not drawn yet — check back soon".
 *
 * Refresh: `AutoRefresh` re-fetches this server component every 60 seconds, so
 * a result your opponent just submitted appears without you reloading.
 *
 * Layout: a single vertical column — Group A, then Group B, and so on — which is
 * how a phone should read it. Each table scrolls sideways INSIDE its own card,
 * never on the page.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import AutoRefresh from '@/components/AutoRefresh';
import GroupCard from '@/components/GroupCard';
import { getGroupStage, getTournamentById } from '@/lib/data';
import { formatDateTime, whatsappLink } from '@/lib/format';

/** Standings change with every result — always render fresh. */
export const dynamic = 'force-dynamic';

/** Props passed by Next.js. */
interface GroupsPageProps {
  params: {
    /** The tournament's UUID, as linked by the organizer. */
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
}: GroupsPageProps): Promise<Metadata> {
  const tournament = UUID_PATTERN.test(params.tournamentId)
    ? await getTournamentById(params.tournamentId)
    : null;

  return {
    title: tournament
      ? `Group Standings — ${tournament.title}`
      : 'Group Standings',
  };
}

/**
 * Renders the group stage.
 *
 * @param props.params Contains the tournament id.
 */
export default async function GroupsPage({ params }: GroupsPageProps) {
  const { tournamentId } = params;

  if (!UUID_PATTERN.test(tournamentId)) {
    return <NotDrawnYet reason="That tournament link is not valid." />;
  }

  const tournament = await getTournamentById(tournamentId);

  if (!tournament) {
    return <NotDrawnYet reason="That tournament could not be found." />;
  }

  const stage = await getGroupStage(tournamentId);

  // The organizer has not run the draw yet (or it produced no groups).
  if (!stage.hasGroups) {
    return <NotDrawnYet tournamentTitle={tournament.title} />;
  }

  // How far the group stage has got — shown as a small progress hint.
  const played = stage.fixtures.filter(
    (fixture) => fixture.status === 'completed',
  ).length;

  return (
    <div className="space-y-5">
      <AutoRefresh intervalSeconds={60} />

      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-pitch-400">
          Group stage
        </p>
        <h1 className="text-xl font-bold text-white">{tournament.title}</h1>
        <p className="text-sm text-slate-400">
          {stage.groups.length} group
          {stage.groups.length === 1 ? '' : 's'} · round robin · top 2 from each
          group advance
        </p>
        <p className="text-xs text-slate-500">
          {played} of {stage.fixtures.length} fixtures played · match deadline:{' '}
          {formatDateTime(tournament.match_deadline)} · this page updates itself
          every 60 seconds.
        </p>
      </header>

      {/* Points + tiebreakers, so players understand the order. */}
      <div className="card text-sm text-slate-300">
        <p>
          <strong className="text-white">Points:</strong> Win = 3, Draw = 1,
          Loss = 0.
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Tiebreakers: Goal Difference → Goals Scored → Head-to-Head → Penalty
          Shootout (the organizer records shootout results).
        </p>
      </div>

      <div className="space-y-5">
        {stage.groups.map((group) => (
          <GroupCard
            key={group.group.id}
            group={group}
            fixtures={stage.fixturesByGroup[group.group.id] ?? []}
          />
        ))}
      </div>

      <section className="space-y-3">
        <Link href="/submit-result" className="btn-primary">
          Submit a match result
        </Link>

        <a
          href={whatsappLink(
            undefined,
            `Hi, I have a question about the group stage of ${tournament.title}.`,
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
 * Friendly placeholder shown when the groups are not available yet.
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
          Groups not drawn yet — check back soon
        </h1>
        <p className="mt-1 text-sm text-amber-100">
          {reason ??
            `The organizer has not run the draw for ${
              tournamentTitle ?? 'this tournament'
            } yet. Every table and fixture appears here the moment the groups are published.`}
        </p>
      </div>

      <Link href="/" className="btn-secondary">
        Back to the tournament
      </Link>
    </div>
  );
}
