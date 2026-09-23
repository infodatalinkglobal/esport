'use client';

/**
 * The registration form (landing page, Section 4).
 *
 * Fields (all required):
 * - full name
 * - WhatsApp number (024XXXXXXX or 05XXXXXXXX)
 * - MoMo number (for the prize payout)
 * - DLS team name
 * - checkbox: "I have completed 6 Career Mode matches and can access Friend Match"
 * - checkbox: "I agree to the tournament rules"
 *
 * Flow: the details are validated in the browser AND again on the server by
 * `/api/register`, which checks that the tournament is still open, not full, and
 * that the phone number has not already registered. That call creates the
 * `pending` registration. Only then does the component swap to the payment
 * panel, so the Paystack popup is opened by a real tap on a real button (which
 * is what stops mobile browsers from blocking it).
 */

import { useRef, useState } from 'react';
import PaystackButton from './PaystackButton';
import type { RegistrationFormProps } from '@/types';
import { isValidGhanaPhone, normalizePhone, whatsappLink } from '@/lib/format';

/** The registration the server created, plus what we show about it. */
interface CreatedRegistration {
  /** `registrations.id` — needed to start the payment. */
  id: string;
  /** Paystack reference, shown so support can trace a payment. */
  reference: string;
  /** Entry fee ready to display, e.g. "GH₵10.00". */
  amountLabel: string;
}

/**
 * Renders the registration form, or the message that replaces it when
 * registration is closed or the tournament is full.
 *
 * @param props Registration form configuration (see {@link RegistrationFormProps}).
 */
export default function RegistrationForm({
  tournamentId,
  entryFeeLabel,
  isOpen,
  isFull,
  spotsLeft,
}: RegistrationFormProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Form fields.
  const [playerName, setPlayerName] = useState('');
  const [phone, setPhone] = useState('');
  const [momo, setMomo] = useState('');
  const [teamName, setTeamName] = useState('');
  const [careerMode, setCareerMode] = useState(false);
  const [agreed, setAgreed] = useState(false);

  // Submission state.
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedRegistration | null>(null);

  // ---------------------------------------------------------------- full
  if (isFull) {
    return (
      <div className="card border-amber-500/40 bg-amber-500/10">
        <h3 className="text-base font-semibold text-amber-200">
          Tournament Full — contact us on WhatsApp
        </h3>
        <p className="mt-1 text-sm text-amber-100">
          Every player slot is taken. Message the organizer and you will be told
          first when the next tournament opens.
        </p>
        <a
          href={whatsappLink(
            undefined,
            'Hi! The tournament is full — please tell me about the next one.',
          )}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-primary mt-3"
        >
          Contact organizer on WhatsApp
        </a>
      </div>
    );
  }

  // --------------------------------------------------------------- closed
  if (!isOpen) {
    return (
      <div className="card">
        <h3 className="text-base font-semibold text-white">
          Registration is now closed
        </h3>
        <p className="mt-1 text-sm text-slate-300">
          The deadline for this tournament has passed. Follow the organizer on
          WhatsApp and you will hear about the next one first.
        </p>
        <a
          href={whatsappLink(
            undefined,
            'Hi! Registration has closed — please tell me about the next tournament.',
          )}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary mt-3"
        >
          Contact organizer on WhatsApp
        </a>
      </div>
    );
  }

  // -------------------------------------------------------------- payment
  // Shown once the pending registration exists. The payment button is a second,
  // deliberate tap so the popup is treated as a genuine user action.
  if (created) {
    return (
      <div ref={panelRef} className="card border-pitch-500/40">
        <h3 className="text-base font-semibold text-white">
          Almost there, {playerName.split(' ')[0] || 'champion'}!
        </h3>
        <p className="mt-1 text-sm text-slate-300">
          Your slot is saved but not secured until payment is confirmed. Pay now
          to lock it in.
        </p>

        <dl className="my-3 space-y-1 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Player</dt>
            <dd className="font-medium text-white">{playerName}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">DLS team</dt>
            <dd className="font-medium text-white">{teamName}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Entry fee</dt>
            <dd className="font-medium text-white">{created.amountLabel}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Reference</dt>
            <dd className="font-mono text-xs text-slate-300">
              {created.reference}
            </dd>
          </div>
        </dl>

        <PaystackButton
          registrationId={created.id}
          amountLabel={created.amountLabel}
        />
      </div>
    );
  }

  // ----------------------------------------------------------------- form
  /**
   * Validates locally, then creates the pending registration on the server.
   *
   * @param event The form submit event.
   */
  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setErrorCode(null);

    // Local checks give instant feedback; the server repeats every one of them.
    if (playerName.trim().length < 2) {
      setError('Please enter your full name.');
      return;
    }
    if (!isValidGhanaPhone(phone)) {
      setError(
        'Enter a valid WhatsApp number in the format 024XXXXXXX or 05XXXXXXXX.',
      );
      return;
    }
    if (!isValidGhanaPhone(momo)) {
      setError(
        'Enter a valid MoMo number in the format 024XXXXXXX or 05XXXXXXXX.',
      );
      return;
    }
    if (teamName.trim().length < 2) {
      setError('Please enter your DLS team name.');
      return;
    }
    if (!careerMode) {
      setError(
        'Confirm that you have completed 6 Career Mode matches and can access Friend Match.',
      );
      return;
    }
    if (!agreed) {
      setError('You must agree to the tournament rules.');
      return;
    }

    setSubmitting(true);

    try {
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournament_id: tournamentId,
          player_name: playerName.trim(),
          phone_number: normalizePhone(phone),
          momo_number: normalizePhone(momo),
          dls_team_name: teamName.trim(),
          career_mode_confirmed: careerMode,
          rules_accepted: agreed,
        }),
      });

      const data = (await response.json()) as {
        success: boolean;
        registration_id?: string;
        reference?: string;
        entry_fee_label?: string;
        error?: string;
        code?: string;
      };

      if (!response.ok || !data.success || !data.registration_id) {
        setError(
          data.error ?? 'We could not save your registration. Please try again.',
        );
        setErrorCode(data.code ?? null);
        return;
      }

      // Registration saved — move to the payment step.
      setCreated({
        id: data.registration_id,
        reference: data.reference ?? '',
        amountLabel: data.entry_fee_label ?? entryFeeLabel,
      });

      // Bring the payment panel into view on a small screen.
      window.requestAnimationFrame(() => {
        panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } catch {
      setError(
        'We could not reach the server. Check your internet connection and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="card space-y-4" noValidate>
      <div>
        <label className="field-label" htmlFor="player_name">
          Full name
        </label>
        <input
          id="player_name"
          name="player_name"
          className="field"
          autoComplete="name"
          placeholder="Kwame Mensah"
          value={playerName}
          onChange={(event) => setPlayerName(event.target.value)}
          required
        />
      </div>

      <div>
        <label className="field-label" htmlFor="phone_number">
          WhatsApp number
        </label>
        <input
          id="phone_number"
          name="phone_number"
          className="field"
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          placeholder="0241234567"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          required
        />
        <p className="mt-1 text-xs text-slate-500">
          Format: 024XXXXXXX or 05XXXXXXXX — this is how we reach you about your
          matches.
        </p>
      </div>

      <div>
        <label className="field-label" htmlFor="momo_number">
          MoMo number (for prize payout)
        </label>
        <input
          id="momo_number"
          name="momo_number"
          className="field"
          type="tel"
          inputMode="numeric"
          placeholder="0241234567"
          value={momo}
          onChange={(event) => setMomo(event.target.value)}
          required
        />
        <p className="mt-1 text-xs text-slate-500">
          Prizes are paid to this number within 1 hour of the Grand Final.
        </p>
      </div>

      <div>
        <label className="field-label" htmlFor="dls_team_name">
          DLS team name
        </label>
        <input
          id="dls_team_name"
          name="dls_team_name"
          className="field"
          placeholder="Accra Lions FC"
          value={teamName}
          onChange={(event) => setTeamName(event.target.value)}
          required
        />
      </div>

      {/* Both checkboxes are mandatory. */}
      <div className="space-y-3">
        <label className="flex min-h-tap cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-slate-900/50 p-3">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5 shrink-0 accent-pitch-500"
            checked={careerMode}
            onChange={(event) => setCareerMode(event.target.checked)}
          />
          <span className="text-sm text-slate-200">
            I have completed 6 Career Mode matches and can access Friend Match
          </span>
        </label>

        <label className="flex min-h-tap cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-slate-900/50 p-3">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5 shrink-0 accent-pitch-500"
            checked={agreed}
            onChange={(event) => setAgreed(event.target.checked)}
          />
          <span className="text-sm text-slate-200">
            I agree to the tournament rules
          </span>
        </label>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
        >
          <p>{error}</p>
          {/* The two errors a player needs help with get a WhatsApp shortcut. */}
          {errorCode === 'duplicate' ||
          errorCode === 'full' ||
          errorCode === 'closed' ||
          errorCode === 'deadline_passed' ? (
            <a
              href={whatsappLink(
                undefined,
                'Hi! I have a question about my DLS tournament registration.',
              )}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block min-h-tap font-semibold text-pitch-400 underline"
            >
              Contact organizer on WhatsApp
            </a>
          ) : null}
        </div>
      ) : null}

      <button type="submit" className="btn-primary" disabled={submitting}>
        {submitting
          ? 'Saving your details…'
          : `Register & Pay ${entryFeeLabel}`}
      </button>

      <p className="text-center text-xs text-slate-500">
        {spotsLeft} slot{spotsLeft === 1 ? '' : 's'} left · Pay with MTN MoMo,
        Vodafone Cash or AirtelTigo.
      </p>
    </form>
  );
}
