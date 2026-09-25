'use client';

/**
 * Result submission form (/submit-result) — MODULES 2 and 3.
 *
 * Two tabs, one form each:
 *   Group Match    — phone, match, both scores, screenshot (Module 2)
 *   Knockout Match — phone, match, "I won" / "I lost", screenshot (Module 3)
 *
 * Group flow:
 *   1. Player types the WhatsApp number they registered with.
 *   2. Picks their match from the open fixtures.
 *   3. Enters their score and the opponent's score.
 *   4. Uploads a screenshot of the final scoreboard (required proof).
 *
 * The screenshot goes STRAIGHT to Supabase Storage from the browser (the
 * `result-screenshots` bucket allows image uploads up to 5MB), and only the
 * resulting URL is posted to our API — so a 3MB photo never travels through
 * our server, which keeps the API fast on mobile data.
 *
 * Knockout flow: the same, except the player reports "I won" / "I lost" because
 * knockout matches never draw. The match is confirmed as soon as both players
 * agree, and the winner is moved into the next round automatically.
 *
 * Either way the match is confirmed the moment the opponent submits an agreeing
 * result; conflicting submissions mark it DISPUTED for the organizer.
 */

import { useMemo, useState } from 'react';
import type { ResultSubmissionFormProps } from '@/types';
import { normalizePhone, whatsappLink } from '@/lib/format';
import {
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_BUCKET,
  buildScreenshotPath,
  screenshotContentType,
} from '@/lib/screenshots';

/** Which tab is open. */
type Tab = 'group' | 'knockout';

/** What the form tells the player after a successful submission. */
interface Outcome {
  /** 'success' renders green, 'warning' renders amber. */
  tone: 'success' | 'warning';
  /** Short headline, e.g. "Result confirmed ✅". */
  title: string;
  /** One or two sentences explaining what happens next. */
  message: string;
}

/**
 * Renders the result submission form.
 *
 * @param props.tournamentId Tournament the matches belong to (null if none).
 * @param props.groupMatches Open group fixtures, as dropdown options.
 * @param props.knockoutMatches Open knockout matches — empty in Module 2.
 */
export default function ResultSubmissionForm({
  tournamentId,
  groupMatches,
  knockoutMatches,
  defaultTab,
}: ResultSubmissionFormProps) {
  // The page passes `defaultTab` from the tournament status; the fallback keeps
  // the form usable if it is ever rendered without that hint.
  const [tab, setTab] = useState<Tab>(
    defaultTab ?? (groupMatches.length > 0 ? 'group' : 'knockout'),
  );

  // Form fields (shared by both tabs).
  const [phone, setPhone] = useState('');
  const [matchId, setMatchId] = useState('');
  const [file, setFile] = useState<File | null>(null);

  // Group tab only.
  const [myScore, setMyScore] = useState('');
  const [opponentScore, setOpponentScore] = useState('');

  // Knockout tab only: which player won, from this player's point of view.
  const [knockoutResult, setKnockoutResult] = useState<'won' | 'lost' | null>(
    null,
  );

  // Submission state.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  /** The options offered by the currently selected tab. */
  const options = useMemo(
    () => (tab === 'group' ? groupMatches : knockoutMatches),
    [tab, groupMatches, knockoutMatches],
  );

  /**
   * Uploads the screenshot to Supabase Storage and returns its public URL.
   *
   * @param selected The image the player chose.
   * @returns The public URL of the uploaded screenshot.
   * @throws Error with a message that is safe to show the player.
   */
  const uploadScreenshot = async (selected: File): Promise<string> => {
    let client;
    try {
      // Loaded on demand: @supabase/supabase-js is ~40kB, and it is only needed
      // by the players who actually upload a screenshot. Keeping it out of the
      // initial bundle keeps this page fast on mobile data.
      //
      // The anon key is enough here: the bucket policy allows public image
      // uploads, and the service-role key never reaches the browser.
      const { supabase } = await import('@/lib/supabase');
      client = supabase();
    } catch {
      throw new Error(
        'Screenshot upload is not configured. Please send your screenshot to the organizer on WhatsApp.',
      );
    }

    // The object name and content type must match what the bucket's upload
    // policy and settings accept — see lib/screenshots.ts.
    const contentType = screenshotContentType(selected.type);
    const path = buildScreenshotPath({ tournamentId, matchId, contentType });
    if (!contentType || !path) {
      throw new Error(
        'We could not prepare your screenshot upload. Refresh the page and try again.',
      );
    }

    // supabase-js sends a File as multipart form data and IGNORES the
    // `contentType` option for it: the storage server sees the file's own
    // type. Re-label the file with the normalised type (e.g. a phone's
    // non-standard "image/jpg" → "image/jpeg") so the bucket's type check
    // passes. slice() shares the bytes — nothing is copied.
    const body =
      selected.type === contentType
        ? selected
        : selected.slice(0, selected.size, contentType);

    const { error: uploadError } = await client.storage
      .from(SCREENSHOT_BUCKET)
      .upload(path, body, {
        cacheControl: '3600',
        upsert: false,
        contentType,
      });

    if (uploadError) {
      // Size and type were already checked above, so this is the network or
      // the storage settings — keep the real reason in the browser console.
      console.error('[screenshot upload] failed', uploadError);
      throw new Error(
        'We could not upload your screenshot. Check your connection and try again — if it keeps failing, send the screenshot to the organizer on WhatsApp.',
      );
    }

    const { data } = client.storage
      .from(SCREENSHOT_BUCKET)
      .getPublicUrl(path);

    if (!data?.publicUrl) {
      throw new Error('We could not attach your screenshot. Please try again.');
    }

    return data.publicUrl;
  };

  /**
   * Validates the form, uploads the proof and posts the result.
   *
   * @param event The form submit event.
   */
  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setOutcome(null);

    // --- 1. Local validation ---------------------------------------------
    if (!/^0[2-5][0-9]{8}$/.test(normalizePhone(phone))) {
      setError(
        'Enter the WhatsApp number you registered with in the format 024XXXXXXX or 05XXXXXXXX.',
      );
      return;
    }
    if (!matchId) {
      setError('Choose the match you are reporting.');
      return;
    }

    const mine = Number(myScore);
    const theirs = Number(opponentScore);

    if (tab === 'group') {
      if (
        myScore === '' ||
        opponentScore === '' ||
        !Number.isInteger(mine) ||
        !Number.isInteger(theirs) ||
        mine < 0 ||
        theirs < 0 ||
        mine > 99 ||
        theirs > 99
      ) {
        setError('Enter both scores as whole numbers between 0 and 99.');
        return;
      }
    } else if (knockoutResult !== 'won' && knockoutResult !== 'lost') {
      // Knockout matches never draw, so the player must pick a side.
      setError('Choose whether you won or lost the match.');
      return;
    }

    if (!file) {
      setError('Screenshot is required as proof of your result.');
      return;
    }
    if (!screenshotContentType(file.type)) {
      setError('Please upload a JPG, PNG or WebP screenshot.');
      return;
    }
    if (file.size > MAX_SCREENSHOT_BYTES) {
      setError('Screenshot must be under 5MB.');
      return;
    }

    // --- 2. Upload + submit ----------------------------------------------
    setBusy(true);

    try {
      const screenshotUrl = await uploadScreenshot(file);

      const response = await fetch('/api/submit-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          tab === 'group'
            ? {
                kind: 'group',
                match_id: matchId,
                phone_number: normalizePhone(phone),
                my_score: mine,
                opponent_score: theirs,
                screenshot_url: screenshotUrl,
              }
            : {
                kind: 'knockout',
                match_id: matchId,
                phone_number: normalizePhone(phone),
                knockout_result: knockoutResult,
                screenshot_url: screenshotUrl,
              },
        ),
      });

      const data = (await response.json()) as {
        success: boolean;
        confirmed?: boolean;
        disputed?: boolean;
        message?: string;
        error?: string;
      };

      if (!response.ok || !data.success) {
        setError(data.error ?? 'We could not save your result. Please try again.');
        return;
      }

      setOutcome({
        tone: data.disputed ? 'warning' : 'success',
        title: data.confirmed
          ? 'Result confirmed ✅'
          : data.disputed
            ? 'Result disputed ⚠️'
            : 'Result saved',
        message:
          data.message ??
          (data.confirmed
            ? 'Both players agree, so the match is confirmed.'
            : 'Your screenshot is in. The match is confirmed automatically as soon as your opponent submits the same result.'),
      });

      // Reset the form but keep the phone number for a second submission.
      setMyScore('');
      setOpponentScore('');
      setKnockoutResult(null);
      setFile(null);
      setMatchId('');

      // Clear the file input too (only a DOM reset can do that).
      const groupInput = document.getElementById(
        'screenshot',
      ) as HTMLInputElement | null;
      if (groupInput) groupInput.value = '';

      const knockoutInput = document.getElementById(
        'knockout_screenshot',
      ) as HTMLInputElement | null;
      if (knockoutInput) knockoutInput.value = '';
    } catch (thrown) {
      setError(
        thrown instanceof Error
          ? thrown.message
          : 'We could not save your result. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* ===================== Tab switcher ============================= */}
      <div
        role="tablist"
        aria-label="Which competition are you reporting?"
        className="grid grid-cols-2 gap-2"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'group'}
          onClick={() => {
            setTab('group');
            setMatchId('');
            setError(null);
            setOutcome(null);
          }}
          className={`flex min-h-tap items-center justify-center rounded-xl border px-3 py-3 text-sm font-semibold transition ${
            tab === 'group'
              ? 'border-pitch-500 bg-pitch-500/15 text-pitch-400'
              : 'border-white/15 bg-slate-900/50 text-slate-300'
          }`}
        >
          Group Match
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={tab === 'knockout'}
          onClick={() => {
            setTab('knockout');
            setMatchId('');
            setError(null);
            setOutcome(null);
          }}
          className={`flex min-h-tap items-center justify-center rounded-xl border px-3 py-3 text-sm font-semibold transition ${
            tab === 'knockout'
              ? 'border-pitch-500 bg-pitch-500/15 text-pitch-400'
              : 'border-white/15 bg-slate-900/50 text-slate-300'
          }`}
        >
          Knockout Match
        </button>
      </div>

      {/* ================= Knockout tab (Module 3) ====================== */}
      {tab === 'knockout' ? (
        <form onSubmit={handleSubmit} className="card space-y-4" noValidate>
          {options.length === 0 ? (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
              <p className="font-semibold">You have no active knockout matches</p>
              <p className="mt-1">
                Knockout fixtures appear here once the organizer draws the
                bracket (after every group match is finished) and your name is in
                it.
              </p>
            </div>
          ) : null}

          <div>
            <label className="field-label" htmlFor="knockout_phone">
              Your WhatsApp number
            </label>
            <input
              id="knockout_phone"
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
              Use the number you registered with — it is how we know which player
              you are.
            </p>
          </div>

          <div>
            <label className="field-label" htmlFor="knockout_match_id">
              Knockout match
            </label>
            <select
              id="knockout_match_id"
              className="field"
              value={matchId}
              onChange={(event) => setMatchId(event.target.value)}
              required
            >
              <option value="">
                {options.length > 0
                  ? 'Choose your match…'
                  : 'No open knockout matches right now'}
              </option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Only matches still waiting for a result are listed.
            </p>
          </div>

          <fieldset>
            <legend className="field-label">Your result</legend>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                aria-pressed={knockoutResult === 'won'}
                onClick={() => setKnockoutResult('won')}
                className={`flex min-h-[56px] items-center justify-center gap-2 rounded-xl border px-3 text-base font-bold transition ${
                  knockoutResult === 'won'
                    ? 'border-pitch-500 bg-pitch-500/20 text-pitch-400'
                    : 'border-white/15 bg-slate-900/50 text-slate-200'
                }`}
              >
                I Won <span aria-hidden="true">✅</span>
              </button>

              <button
                type="button"
                aria-pressed={knockoutResult === 'lost'}
                onClick={() => setKnockoutResult('lost')}
                className={`flex min-h-[56px] items-center justify-center gap-2 rounded-xl border px-3 text-base font-bold transition ${
                  knockoutResult === 'lost'
                    ? 'border-red-500 bg-red-500/20 text-red-200'
                    : 'border-white/15 bg-slate-900/50 text-slate-200'
                }`}
              >
                I Lost <span aria-hidden="true">❌</span>
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Knockout matches never end in a draw — extra time and penalties
              decide it. Both players must agree before the winner is confirmed.
            </p>
          </fieldset>

          <div>
            <label className="field-label" htmlFor="knockout_screenshot">
              Screenshot of the final scoreboard (required)
            </label>
            <input
              id="knockout_screenshot"
              className="field file:mr-3 file:rounded-lg file:border-0 file:bg-pitch-500 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-slate-950"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              required
            />
            <p className="mt-1 text-xs text-slate-500">
              JPG, PNG or WebP, up to 5MB. If the two players disagree, the match
              becomes DISPUTED and the organizer reviews it within 24 hours.
            </p>
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <p>{error}</p>
              <a
                href={whatsappLink(
                  undefined,
                  'Hi, I had a problem submitting my DLS knockout result.',
                )}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block min-h-tap font-semibold text-pitch-400 underline"
              >
                Contact organizer on WhatsApp
              </a>
            </div>
          ) : null}

          {outcome ? (
            <div
              role="status"
              className={
                outcome.tone === 'success'
                  ? 'rounded-xl border border-pitch-500/40 bg-pitch-500/10 p-3 text-sm text-pitch-100'
                  : 'rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100'
              }
            >
              <p className="font-semibold">{outcome.title}</p>
              <p className="mt-1">{outcome.message}</p>
            </div>
          ) : null}

          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Uploading and saving…' : 'Submit result'}
          </button>

          <p className="text-center text-xs text-slate-500">
            Prizes are paid by MoMo within 1 hour of the Grand Final.
          </p>
        </form>
      ) : (
        /* ================== Group tab (Module 2) ====================== */
                <form onSubmit={handleSubmit} className="card space-y-4" noValidate>
          <div>
            <label className="field-label" htmlFor="result_phone">
              Your WhatsApp number
            </label>
            <input
              id="result_phone"
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
              Use the number you registered with — it is how we know which player
              you are.
            </p>
          </div>

          <div>
            <label className="field-label" htmlFor="match_id">
              Match
            </label>
            <select
              id="match_id"
              className="field"
              value={matchId}
              onChange={(event) => setMatchId(event.target.value)}
              required
            >
              <option value="">
                {options.length > 0
                  ? 'Choose your match…'
                  : 'No open group matches right now'}
              </option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Only fixtures still waiting for a result are listed.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label" htmlFor="my_score">
                My score
              </label>
              <input
                id="my_score"
                className="field text-center"
                type="number"
                inputMode="numeric"
                min={0}
                max={99}
                value={myScore}
                onChange={(event) => setMyScore(event.target.value)}
                required
              />
            </div>
            <div>
              <label className="field-label" htmlFor="opponent_score">
                Opponent score
              </label>
              <input
                id="opponent_score"
                className="field text-center"
                type="number"
                inputMode="numeric"
                min={0}
                max={99}
                value={opponentScore}
                onChange={(event) => setOpponentScore(event.target.value)}
                required
              />
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="screenshot">
              Screenshot of the final scoreboard (required)
            </label>
            <input
              id="screenshot"
              className="field file:mr-3 file:rounded-lg file:border-0 file:bg-pitch-500 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-slate-950"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              required
            />
            <p className="mt-1 text-xs text-slate-500">
              JPG, PNG or WebP, up to 5MB. BOTH players must submit one — if they
              do not match, the match becomes DISPUTED.
            </p>
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <p>{error}</p>
              <a
                href={whatsappLink(
                  undefined,
                  'Hi, I had a problem submitting my DLS match result.',
                )}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block min-h-tap font-semibold text-pitch-400 underline"
              >
                Contact organizer on WhatsApp
              </a>
            </div>
          ) : null}

          {outcome ? (
            <div
              role="status"
              className={
                outcome.tone === 'success'
                  ? 'rounded-xl border border-pitch-500/40 bg-pitch-500/10 p-3 text-sm text-pitch-100'
                  : 'rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100'
              }
            >
              <p className="font-semibold">{outcome.title}</p>
              <p className="mt-1">{outcome.message}</p>
            </div>
          ) : null}

          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Uploading and saving…' : 'Submit result'}
          </button>

          <p className="text-center text-xs text-slate-500">
            Submit within 1 hour of the match ending. Draws are allowed in the
            group stage.
          </p>
        </form>
      )}
    </div>
  );
}
