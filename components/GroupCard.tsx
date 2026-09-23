/**
 * One group on the standings page: a green-bordered card containing the league
 * table followed by that group's fixtures.
 *
 * Cards stack vertically on mobile (the page is a single column at every width
 * below `md`), so nothing needs pinching or sideways scrolling.
 */

import type { GroupCardProps } from '@/types';
import GroupStandingsTable from './GroupStandingsTable';
import GroupFixtures from './GroupFixtures';

/**
 * Renders one group section.
 *
 * @param props.group The group plus its sorted standings.
 * @param props.fixtures That group's fixtures.
 */
export default function GroupCard({ group, fixtures }: GroupCardProps) {
  const { group: groupRow, standings } = group;

  return (
    <section
      aria-labelledby={`group-${groupRow.group_name}-heading`}
      className="rounded-2xl border border-pitch-500/30 bg-white/[0.04] p-4"
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2
          id={`group-${groupRow.group_name}-heading`}
          className="text-lg font-bold text-white"
        >
          Group {groupRow.group_name}
        </h2>
        <span className="flex items-center gap-1.5 text-xs text-slate-400">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-full bg-pitch-400"
          />
          Top 2 advance
        </span>
      </header>

      <GroupStandingsTable
        standings={standings}
        groupName={groupRow.group_name}
      />

      <div className="mt-5">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Fixtures
        </h3>
        <GroupFixtures fixtures={fixtures} />
      </div>
    </section>
  );
}
