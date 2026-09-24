'use client';

/**
 * Small shared building blocks for the admin dashboard (MODULE 4).
 *
 * Deliberately tiny, and deliberately light: the dashboard wears its own
 * back-office skin (see the admin component classes in globals.css) so it
 * reads as a separate control panel rather than a player page. It adds the few
 * pieces an operator screen needs — stat cards, payment badges and a two-tap
 * confirmation button (no window.confirm, which embedded browsers block).
 */

import { useState, type ReactNode } from 'react';
import type { AdminActionState, PaymentStatus } from '@/types';

/* ------------------------------------------------------------------ StatCard */

/** Props for {@link StatCard}. */
interface StatCardProps {
  /** The number or short value, already formatted. */
  value: ReactNode;
  /** What the number counts, e.g. 'Paid players'. */
  label: string;
  /** Optional second line under the value. */
  sub?: string;
  /** Draws the eye when true (green accent for good news). */
  accent?: boolean;
}

/**
 * One number in the Overview's stat grid.
 *
 * @param props See {@link StatCardProps}.
 */
export function StatCard({ value, label, sub, accent = false }: StatCardProps) {
  return (
    <div className="acard flex flex-col gap-1 p-4">
      <span
        className={`text-2xl font-extrabold tabular-nums ${
          accent ? 'text-pitch-600' : 'text-slate-900'
        }`}
      >
        {value}
      </span>
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {sub ? <span className="text-sm text-slate-500">{sub}</span> : null}
    </div>
  );
}

/* -------------------------------------------------------------- PaymentBadge */

const PAYMENT_BADGE_CLASSES: Record<PaymentStatus, string> = {
  paid: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  pending: 'border-amber-200 bg-amber-50 text-amber-700',
  failed: 'border-red-200 bg-red-50 text-red-700',
  refunded: 'border-slate-200 bg-slate-100 text-slate-600',
};

/**
 * A payment-status badge (the organizer's colour language for money).
 *
 * @param props.status `paid` | `pending` | `failed` | `refunded`.
 */
export function PaymentBadge({ status }: { status: PaymentStatus }) {
  return <span className={`abadge ${PAYMENT_BADGE_CLASSES[status]}`}>{status}</span>;
}

const MATCH_BADGE_CLASSES = {
  pending: 'border-amber-200 bg-amber-50 text-amber-700',
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  disputed: 'border-red-200 bg-red-50 text-red-700',
} as const;

/**
 * A match-status badge.
 *
 * @param props.status `pending` | `completed` | `disputed`.
 */
export function MatchBadge({ status }: { status: 'pending' | 'completed' | 'disputed' }) {
  return <span className={`abadge ${MATCH_BADGE_CLASSES[status]}`}>{status}</span>;
}

/* ------------------------------------------------------------ ConfirmButton */

/** Props for {@link ConfirmButton}. */
interface ConfirmButtonProps {
  /** The button's normal label, e.g. 'Draw groups'. */
  label: string;
  /** What the second tap asks, e.g. 'Delete 3 results and redraw?'. */
  confirmLabel?: string;
  /** Called when the organizer confirms. */
  onConfirm: () => void | Promise<void>;
  /** Disabled state. */
  disabled?: boolean;
  /** Why it is disabled (shown under the button). */
  reason?: string;
  /** Red styling for destructive actions. */
  danger?: boolean;
  /** While true the button shows 'Working…' and ignores taps. */
  busy?: boolean;
}

/**
 * A button that never fires on the first tap: the first tap arms it, the
 * second confirms, anything else (or 5 seconds) disarms it. Destructive
 * actions therefore need intent twice — without window.confirm.
 *
 * @param props See {@link ConfirmButtonProps}.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled = false,
  reason,
  danger = false,
  busy = false,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);

  const base = danger
    ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50';

  return (
    <div className="flex w-full flex-col gap-1">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => {
          if (armed) {
            setArmed(false);
            void onConfirm();
          } else if (!disabled && !busy) {
            setArmed(true);
            window.setTimeout(() => setArmed(false), 5000);
          }
        }}
        className={`flex min-h-tap w-full items-center justify-center gap-2 rounded-lg border px-4 py-3
          text-base font-semibold shadow-sm transition active:scale-[0.99]
          disabled:cursor-not-allowed disabled:opacity-60
          ${armed ? 'border-pitch-600 bg-pitch-50 text-pitch-700' : base}`}
      >
        {busy ? 'Working…' : armed ? (confirmLabel ?? 'Tap again to confirm') : label}
      </button>
      {reason ? <p className="px-1 text-xs leading-snug text-slate-500">{reason}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Banner */

/** Props for {@link Banner}. */
interface BannerProps {
  /** 'ok' (green) or 'error' (red). */
  tone: 'ok' | 'error';
  /** The message to show. */
  children: ReactNode;
}

/**
 * A one-line result banner (action succeeded / failed).
 *
 * @param props See {@link BannerProps}.
 */
export function Banner({ tone, children }: BannerProps) {
  return (
    <div
      role="status"
      className={`rounded-xl border px-4 py-3 text-sm font-medium ${
        tone === 'ok'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-red-200 bg-red-50 text-red-700'
      }`}
    >
      {children}
    </div>
  );
}

/* --------------------------------------------------------------- ActionNote */

/**
 * The small print under a lifecycle button: the action's availability, made
 * human (the reason is always filled in for disabled actions).
 *
 * @param props.state One action's availability from the overview.
 */
export function ActionNote({ state }: { state: AdminActionState }) {
  if (state.allowed || !state.reason) return null;
  return <p className="text-xs leading-snug text-slate-500">{state.reason}</p>;
}
