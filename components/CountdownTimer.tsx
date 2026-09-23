'use client';

/**
 * Live countdown to the registration deadline.
 *
 * Mobile-first details:
 * - four equal boxes that fit a 375px screen with no horizontal scrolling
 * - the very first render is a stable placeholder ("--"), so the server HTML
 *   and the browser HTML match exactly (no hydration warning, no layout jump)
 * - it shows "Registration Closed ❌" the moment the deadline passes
 */

import { useEffect, useMemo, useState } from 'react';
import type { CountdownTimerProps } from '@/types';

/** The countdown, broken into its four parts. */
interface Remaining {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  expired: boolean;
}

/**
 * Converts a target timestamp into whole days/hours/minutes/seconds.
 *
 * @param targetMs Epoch milliseconds to count down to.
 * @returns The breakdown, with `expired: true` when the time has passed.
 */
function getRemaining(targetMs: number): Remaining {
  const diff = targetMs - Date.now();

  if (Number.isNaN(targetMs) || diff <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
  }

  const totalSeconds = Math.floor(diff / 1000);

  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    expired: false,
  };
}

/**
 * Two-digit display, e.g. 7 → "07".
 *
 * @param value Any non-negative number.
 * @returns The value padded to two characters.
 */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The four boxes, in display order. */
const LABELS: Array<{ key: keyof Omit<Remaining, 'expired'>; label: string }> = [
  { key: 'days', label: 'Days' },
  { key: 'hours', label: 'Hours' },
  { key: 'minutes', label: 'Minutes' },
  { key: 'seconds', label: 'Seconds' },
];

/**
 * Renders the countdown.
 *
 * @param props.targetDate ISO timestamp (or epoch ms) to count down to.
 * @param props.label Optional heading above the digits.
 * @param props.onComplete Optional callback fired once when it reaches zero.
 */
export default function CountdownTimer({
  targetDate,
  label,
  onComplete,
}: CountdownTimerProps) {
  const targetMs = useMemo(
    () =>
      typeof targetDate === 'number'
        ? targetDate
        : new Date(targetDate).getTime(),
    [targetDate],
  );

  // null until mounted: keeps the server-rendered HTML identical to the first
  // client render.
  const [remaining, setRemaining] = useState<Remaining | null>(null);

  useEffect(() => {
    const tick = () => {
      const next = getRemaining(targetMs);
      setRemaining(next);
      // `onComplete` fires on every tick once expired; the parent decides what
      // to do, and the expiry message is shown below in any case.
      if (next.expired) onComplete?.();
    };

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [targetMs, onComplete]);

  const expired = remaining?.expired ?? false;

  return (
    <div>
      {label ? (
        <p className="mb-2 text-sm font-medium text-slate-400">{label}</p>
      ) : null}

      <div
        className="grid grid-cols-4 gap-2"
        role="timer"
        aria-live="off"
        aria-label="Time left to register"
      >
        {LABELS.map((entry) => (
          <div
            key={entry.key}
            className="rounded-xl border border-white/10 bg-slate-900/70 py-2 text-center"
          >
            <span className="block text-xl font-bold tabular-nums text-pitch-400">
              {remaining ? pad(remaining[entry.key]) : '--'}
            </span>
            <span className="mt-0.5 block text-[11px] uppercase tracking-wide text-slate-500">
              {entry.label}
            </span>
          </div>
        ))}
      </div>

      {expired ? (
        <p
          role="status"
          className="mt-2 text-sm font-semibold text-red-300"
        >
          Registration Closed <span aria-hidden="true">❌</span>
        </p>
      ) : null}
    </div>
  );
}
