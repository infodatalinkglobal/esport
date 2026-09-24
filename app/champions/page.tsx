/**
 * Champions Hall (/champions)
 *
 * The history page: every completed tournament with its Grand Final result —
 * champion, runner-up, and the prizes that were paid. It fills up on its own:
 * a tournament appears here the moment its final is confirmed (which also sets
 * the tournament to `completed`).
 *
 * Pure server component — no JavaScript, loads in one request on the slowest
 * phone.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { getChampionsHall } from '@/lib/data';
import { formatCedis } from '@/lib/calculations';
import { formatDateTime } from '@/lib/format';

/** Completed tournaments only change when a final is confirmed — still dynamic. */
export const dynamic = 'force-dynamic';

/** Page metadata. */
export const metadata: Metadata = {
  title: 'Champions Hall',
  description:
    'Every DLS Tournament GH champion, runner-up and prize — the full honours list.',
};

/**
 * Renders the honours list.
 */
export default async function ChampionsPage() {
  const entries = await getChampionsHall();

  return (
    <div className="space-y-5">
      <header className="space-y-1 text-center">
        <p className="text-4xl" aria-hidden="true">
          🏆
        </p>
        <h1 className="text-xl font-bold text-white">Champions Hall</h1>
        <p className="text-sm text-slate-400">
          Every final ever played on DLS Tournament GH.
        </p>
      </header>

      {entries.length === 0 ? (
        <div className="card border-amber-500/40 bg-amber-500/10 text-center">
          <h2 className="text-base font-semibold text-amber-200">
            History starts with the first final
          </h2>
          <p className="mt-1 text-sm text-amber-100">
            No tournament has been completed yet. The first champion lands here
            the moment their Grand Final is confirmed.
          </p>
        </div>
      ) : (
        <ol className="space-y-4">
          {entries.map((entry, index) => (
            <li
              key={entry.tournament.id}
              className="card border-pitch-500/30 bg-white/[0.04]"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="min-w-0 text-lg font-bold text-white">
                  {entry.tournament.title}
                </h2>
                {index === 0 ? (
                  <span className="badge shrink-0 border-amber-400/40 bg-amber-400/10 text-amber-200">
                    Latest
                  </span>
                ) : null}
              </div>

              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3 rounded-xl bg-pitch-500/10 px-3 py-2.5">
                  <dt className="font-semibold text-white">
                    🏆 Champion
                  </dt>
                  <dd className="text-right">
                    <span className="block font-bold text-pitch-400">
                      {entry.champion_name}
                    </span>
                    <span className="block text-xs text-slate-400">
                      {entry.champion_team} · {formatCedis(entry.champion_prize)}
                    </span>
                  </dd>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2.5">
                  <dt className="font-semibold text-white">🥈 Runner-up</dt>
                  <dd className="text-right">
                    <span className="block font-semibold text-white">
                      {entry.runner_up_name}
                    </span>
                    <span className="block text-xs text-slate-400">
                      {entry.runner_up_team} ·{' '}
                      {formatCedis(entry.runner_up_prize)}
                    </span>
                  </dd>
                </div>
              </dl>

              <p className="mt-3 text-xs text-slate-500">
                Final confirmed · match deadline was{' '}
                {formatDateTime(entry.tournament.match_deadline)}
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  href={`/bracket/${entry.tournament.id}`}
                  className="btn-secondary text-sm"
                >
                  View the bracket
                </Link>
                <Link
                  href={`/groups/${entry.tournament.id}`}
                  className="btn-secondary text-sm"
                >
                  Group tables
                </Link>
              </div>
            </li>
          ))}
        </ol>
      )}

      <Link href="/" className="btn-secondary">
        Back to the tournament
      </Link>
    </div>
  );
}
