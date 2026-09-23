'use client';

/**
 * Result submission form (/submit-result) — MODULE 2: GROUP MATCHES ONLY.
 *
 * The tab switcher shows both tabs from the start, because the layout is part
 * of the brief. The Knockout Match tab is a "Coming soon" placeholder until
 * Module 3 wires it up.
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
 * After submitting, the match is confirmed automatically the moment the
 * opponent submits the same scoreline; conflicting scores mark it DISPUTED.
 */

import { useMemo, useState } from 'react';
import type { ResultSubmissionFormProps } from '@/types';
import { normalizePhone, whatsappLink } from '@/lib/format';

/** Which tab is open. */
type Tab = 'group' | 'knockout';

/** Largest screenshot we accept, in bytes (matches the storage policy). */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/** Image types the storage bucket and the brief allow (jpg, png, webp). */
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

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
}: ResultSubmissionFormProps) {
  const [tab, setTab] = useState<Tab>(
    groupMatches.length > 0 ? 'group' : 'knockout',
  );

  // Form fields.
  const [phone, setPhone] = useState('');
  const [matchId, setMatchId] = useState('');
  const [myScore, setMyScore] = useState('');
  const [opponentScore, setOpponentScore] = useState('');
  const [file, setFile] = useState<File | null>(null);

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

    const extension =
      selected.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') ||
      'jpg';
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const path = `${tournamentId ?? 'unknown'}/${matchId}/${unique}.${extension}`;

    const { error: uploadError } = await client.storage
      .from('result-screenshots')
      .upload(path, selected, {
        cacheControl: '3600',
        upsert: false,
        contentType: selected.type || 'image/jpeg',
      });

    if (uploadError) {
      throw new Error(
        'We could not upload your screenshot. Use a smaller image (under 5MB) and try again.',
      );
    }

    const { data } = client.storage
      .from('result-screenshots')
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

    if (!file) {
      setError('Screenshot is required as proof of your result.');
      return;
    }
    if (!ALLOWED_TYPES.includes(file.type.toLowerCase())) {
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
        body: JSON.stringify({
          kind: 'group',
          match_id: matchId,
          phone_number: normalizePhone(phone),
          my_score: mine,
          opponent_score: theirs,
          screenshot_url: screenshotUrl,
        }),
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
            ? 'Both players submitted the same score, so the match is confirmed and the group table has been updated.'
            : 'Your screenshot is in. The match is confirmed automatically as soon as your opponent submits the same score.'),
      });

      // Reset the form but keep the phone number for a second submission.
      setMyScore('');
      setOpponentScore('');
      setFile(null);
      setMatchId('');
      const input = document.getElementById('screenshot') as HTMLInputElement | null;
      if (input) input.value = '';
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

      {/* ============ Knockout tab — Module 3 placeholder =============== */}
      {tab === 'knockout' ? (
        <div className="card border-amber-500/40 bg-amber-500/10">
          <h3 className="text-base font-semibold text-amber-200">
            Knockout Match — Coming soon
          </h3>
          <p className="mt-1 text-sm text-amber-100">
            Knockout results open as soon as the organizer draws the bracket
            (after every group match is finished). Until then, submit your group
            match results on the Group Match tab.
          </p>
          <a
            href={whatsappLink(
              undefined,
              'Hi! I want to know when the knockout stage starts.',
            )}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary mt-3"
          >
            Ask the organizer on WhatsApp
          </a>
        </div>
      ) : (
        /* =================== Group tab ================================= */
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
