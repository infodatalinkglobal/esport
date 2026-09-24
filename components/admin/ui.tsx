'use client';

/**
 * Small shared building blocks for the admin dashboard (MODULE 4).
 *
 * Deliberately tiny: the dashboard reuses the player site's Tailwind component
 * classes (.card, .btn-primary, .badge, .field) and only adds the few pieces
 * an operator screen needs — stat cards, payment badges and a two-tap
 * confirmation button (no window.confirm, which embedded browsers block).
 */

import { useState, type ReactNode } from 'react';
import type { AdminActionState, PaymentStatus } from '@/types';
import { matchStatusClasses, matchStatusEmoji } from '@/lib/format';

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
    <div className="card flex flex-col gap-1 p-4">
      <span
        className={`text-2xl font-extrabold tabular-nums ${
          accent ? 'text-pitch-400' : 'text-slate-100'
        }`}
      >
        {value}
      </span>
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </span>
      {sub ? <span className="text-sm text-slate-400">{sub}</span> : null}
    </div>
  );
}

/* -------------------------------------------------------------- PaymentBadge */

const PAYMENT_BADGE_CLASSES: Record<PaymentStatus, string> = {
  paid: 'border-pitch-500/40 bg-pitch-500/10 text-pitch-300',
  pending: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  failed: 'border-red-400/40 bg-red-400/10 text-red-300',
};

/**
 * A payment-status badge (the organizer's colour language for money).
 *
 * @param props.status `paid` | `pending` | `failed`.
 */
export function PaymentBadge({ status }: { status: PaymentStatus }) {
  return (
    <span className={`badge ${PAYMENT_BADGE_CLASSES[status]}`}>{status}</span>
  );
}

/**
 * A match-status badge, matching the player pages' colours exactly.
 *
 * @param props.status `pending` | `completed` | `disputed`.
 */
export function MatchBadge({ status }: { status: 'pending' | 'completed' | 'disputed' }) {
  return (
    <span className={`badge ${matchStatusClasses(status)}`}>
      {matchStatusEmoji(status)} {status}
    </span>
  );
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
    ? 'border-red-400/40 bg-red-400/10 text-red-300 hover:bg-red-400/20'
    : 'border-white/20 bg-white/5 text-slate-100 hover:bg-white/10';

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
        className={`flex min-h-tap w-full items-center justify-center gap-2 rounded-xl border px-4 py-3
          text-base font-semibold transition active:scale-[0.99]
          disabled:cursor-not-allowed disabled:opacity-60
          ${armed ? 'border-pitch-400 bg-pitch-500/20 text-pitch-200' : base}`}
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
          ? 'border-pitch-500/40 bg-pitch-500/10 text-pitch-300'
          : 'border-red-400/40 bg-red-400/10 text-red-300'
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
