/**
 * The league table for one group.
 *
 * Mobile-first notes:
 * - the table scrolls HORIZONTALLY inside its own container only, so the page
 *   itself never scrolls sideways (a hard requirement)
 * - the top two rows — the players who advance to the knockout stage — are
 *   highlighted in GREEN, on a green tint so the highlight survives a bright
 *   Accra afternoon
 */

import type { GroupStandingsTableProps } from '@/types';

/**
 * The numeric columns, in display order.
 * `key` must match a field on `StandingRow`.
 */
const NUMERIC_COLUMNS = [
  { key: 'played', label: 'P' },
  { key: 'won', label: 'W' },
  { key: 'drawn', label: 'D' },
  { key: 'lost', label: 'L' },
  { key: 'goals_for', label: 'GF' },
  { key: 'goals_against', label: 'GA' },
  { key: 'goal_difference', label: 'GD' },
  { key: 'points', label: 'Pts' },
] as const;

/**
 * Renders a group's standings table.
 *
 * @param props.standings Rows already sorted by the full tiebreaker order.
 * @param props.groupName The group letter, e.g. 'A'.
 */
export default function GroupStandingsTable({
  standings,
  groupName,
}: GroupStandingsTableProps) {
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[420px] border-collapse text-sm">
        <caption className="sr-only">
          Group {groupName} standings. The top two players advance to the
          knockout stage and are highlighted in green. Columns: played, won,
          drawn, lost, goals for, goals against, goal difference, points.
        </caption>

        <thead>
          <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-slate-500">
            <th scope="col" className="w-6 py-2 text-left font-semibold">
              Pos
            </th>
            <th scope="col" className="py-2 pr-2 text-left font-semibold">
              Player
            </th>
            {NUMERIC_COLUMNS.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="w-8 py-2 text-center font-semibold"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {standings.length === 0 ? (
            <tr>
              <td
                colSpan={NUMERIC_COLUMNS.length + 2}
                className="py-4 text-center text-sm text-slate-500"
              >
                No players in this group yet.
              </td>
            </tr>
          ) : (
            standings.map((row) => (
              <tr
                key={row.player_id}
                /* Green = advances to the knockout stage. */
                className={
                  row.advances
                    ? 'border-b border-pitch-500/30 bg-pitch-500/10'
                    : 'border-b border-white/5'
                }
              >
                <td className="py-2.5 text-left">
                  <span
                    className={
                      row.advances
                        ? 'font-bold text-pitch-400'
                        : 'font-semibold text-slate-500'
                    }
                  >
                    {row.position}
                  </span>
                </td>

                <td className="py-2.5 pr-2">
                  <span className="block font-semibold leading-tight text-white">
                    {row.player_name}
                  </span>
                  <span className="block text-xs leading-tight text-slate-400">
                    {row.dls_team_name}
                  </span>
                </td>

                {NUMERIC_COLUMNS.map((column) => (
                  <td
                    key={column.key}
                    className={
                      column.key === 'points'
                        ? 'w-8 text-center font-bold tabular-nums text-white'
                        : 'w-8 text-center tabular-nums text-slate-300'
                    }
                  >
                    {row[column.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
