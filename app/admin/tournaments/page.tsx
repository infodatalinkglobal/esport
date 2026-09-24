'use client';

/**
 * /admin/tournaments — the Tournament tab (MODULE 4).
 *
 * Two jobs:
 *   1. edit the selected tournament — title, deadlines, size, entry fee,
 *      under the same rules the PATCH endpoint enforces (the fee is frozen
 *      once registration closes, the size stays format-supported, and a
 *      tournament with fixtures cannot be reshaped);
 *   2. create the next tournament — the new row is 'open' immediately and,
 *      because the homepage advertises the newest unfinished tournament, it
 *      becomes the one players see (the form says so before you click).
 *
 * The sub-components live at module level on purpose: a component defined
 * inside the page would be a brand-new type on every render and remount its
 * inputs, losing focus while the organizer types.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import type { Tournament } from '@/types';
import { useAdmin } from '@/components/admin/admin-context';
import { Banner } from '@/components/admin/ui';
import { adminFetch } from '@/lib/admin-client';
import { formatCedis } from '@/lib/calculations';
import { formatDateTime } from '@/lib/format';

/** Shape of both forms' editable fields. */
interface DraftState {
  title: string;
  entry_fee_cedis: string;
  max_players: string;
  registration_deadline: string;
  match_deadline: string;
}

/** The size options this knockout format can actually finish. */
const SUPPORTED_SIZES = [6, 7, 8, 13, 14, 15, 16];

/** datetime-local's value format (YYYY-MM-DDTHH:mm). */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A local datetime-local string → ISO. */
function fromLocalInput(value: string): string {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? '' : new Date(time).toISOString();
}

/* ------------------------------------------------------------------ Field */

/** Props for {@link Field}. */
interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** The input's id (also the label's target). */
  id: string;
  /** The label above the input. */
  label: string;
  /** Locks the input and shows why, when set. */
  locked?: string;
  children?: ReactNode;
}

/**
 * One labelled form field (a controlled input with the site's .field class).
 *
 * @param props See {@link FieldProps}; everything else spreads onto the input.
 */
function Field({ id, label, locked, children, ...inputProps }: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input id={id} className="field" disabled={Boolean(locked)} {...inputProps} />
      {children}
      {locked ? <p className="mt-1 text-xs text-slate-500">{locked}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------- CreateForm */

/** Props for {@link CreateForm}. */
interface CreateFormProps {
  /** The shared draft (the create form owns it when nothing is selected). */
  draft: DraftState;
  /** Updates one draft field. */
  onChange: (patch: Partial<DraftState>) => void;
  /** Submits the create request. */
  onSubmit: (event: FormEvent) => void;
  /** While a request is in flight. */
  busy: boolean;
}

/**
 * The "start the next tournament" form.
 *
 * @param props See {@link CreateFormProps}.
 */
function CreateForm({ draft, onChange, onSubmit, busy }: CreateFormProps) {
  return (
    <form onSubmit={onSubmit} className="card flex flex-col gap-3">
      <Field
        id="new-title"
        label="Title"
        required
        minLength={3}
        maxLength={80}
        value={draft.title}
        onChange={(event) => onChange({ title: event.target.value })}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          id="new-fee"
          label="Entry fee (GH₵)"
          type="number"
          inputMode="decimal"
          min={1}
          max={1000}
          step="0.5"
          required
          value={draft.entry_fee_cedis}
          onChange={(event) => onChange({ entry_fee_cedis: event.target.value })}
        />
        <div>
          <label htmlFor="new-max" className="field-label">
            Max players
          </label>
          <select
            id="new-max"
            className="field"
            required
            value={draft.max_players}
            onChange={(event) => onChange({ max_players: event.target.value })}
          >
            <option value="" disabled>
              Pick a size…
            </option>
            {SUPPORTED_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} players ({size <= 8 ? '2 groups' : '4 groups'})
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          id="new-registration-deadline"
          label="Registration closes"
          type="datetime-local"
          required
          value={draft.registration_deadline}
          onChange={(event) => onChange({ registration_deadline: event.target.value })}
        />
        <Field
          id="new-match-deadline"
          label="Matches due by"
          type="datetime-local"
          required
          value={draft.match_deadline}
          onChange={(event) => onChange({ match_deadline: event.target.value })}
        />
      </div>
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create tournament'}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------- Page */

/**
 * The Tournament settings page.
 *
 * @returns The edit form for the selected tournament and the create form.
 */
export default function AdminTournamentsPage() {
  const { secret, selectedId, tournaments, logout, selectTournament, reloadTournaments } =
    useAdmin();

  const tournament = useMemo(
    () => tournaments.find((item) => item.tournament.id === selectedId)?.tournament ?? null,
    [tournaments, selectedId],
  );

  const [draft, setDraft] = useState<DraftState>({
    title: '',
    entry_fee_cedis: '',
    max_players: '',
    registration_deadline: '',
    match_deadline: '',
  });
  /** The create form's own draft, so editing one never clobbers the other. */
  const [createDraft, setCreateDraft] = useState<DraftState>({
    title: '',
    entry_fee_cedis: '',
    max_players: '',
    registration_deadline: '',
    match_deadline: '',
  });
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<'patch' | 'create' | null>(null);

  // Fill the edit form whenever the selection (or its data) changes.
  useEffect(() => {
    if (!tournament) return;
    setDraft({
      title: tournament.title,
      entry_fee_cedis: (tournament.entry_fee / 100).toString(),
      max_players: tournament.max_players.toString(),
      registration_deadline: toLocalInput(tournament.registration_deadline),
      match_deadline: toLocalInput(tournament.match_deadline),
    });
  }, [tournament]);

  /** Updates one field of the edit form. */
  const onDraftChange = useCallback((patch: Partial<DraftState>) => {
    setDraft((state) => ({ ...state, ...patch }));
  }, []);

  /** Updates one field of the create form. */
  const onCreateChange = useCallback((patch: Partial<DraftState>) => {
    setCreateDraft((state) => ({ ...state, ...patch }));
  }, []);

  /** Which edit fields are locked, and why (mirrors the server's rules). */
  const locks = useMemo(() => {
    if (!tournament) return { all: '', fee: '' };
    const editable = tournament.status === 'open' || tournament.status === 'closed';
    return {
      all: !editable
        ? tournament.status === 'completed'
          ? 'Completed tournaments are history.'
          : 'Fixtures already exist — only results can change now.'
        : '',
      fee: editable && tournament.status !== 'open' ? 'Frozen — registration is closed.' : '',
    };
  }, [tournament]);

  /**
   * Saves the edit form (only the fields that actually changed are sent).
   *
   * @param event The form submission.
   */
  const saveEdit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!secret || !tournament || busy) return;

      const body: Record<string, unknown> = { id: tournament.id };
      if (draft.title !== tournament.title) body.title = draft.title;
      const fee = Math.round(Number(draft.entry_fee_cedis) * 100);
      if (Number.isFinite(fee) && fee !== tournament.entry_fee) body.entry_fee = fee;
      const max = Number(draft.max_players);
      if (Number.isInteger(max) && max !== tournament.max_players) body.max_players = max;
      const registrationDeadline = fromLocalInput(draft.registration_deadline);
      if (registrationDeadline && registrationDeadline !== tournament.registration_deadline) {
        body.registration_deadline = registrationDeadline;
      }
      const matchDeadline = fromLocalInput(draft.match_deadline);
      if (matchDeadline && matchDeadline !== tournament.match_deadline) {
        body.match_deadline = matchDeadline;
      }

      if (Object.keys(body).length <= 1) {
        setBanner({ tone: 'ok', text: 'Nothing changed — the tournament is up to date.' });
        return;
      }

      setBusy('patch');
      const result = await adminFetch<{ tournament: Tournament }>('/api/admin/tournaments', secret, {
        method: 'PATCH',
        body,
      });
      setBusy(null);

      if (result.status === 401) {
        logout();
        return;
      }

      setBanner(
        result.ok
          ? { tone: 'ok', text: 'Tournament updated.' }
          : { tone: 'error', text: result.error ?? 'That did not work. Try again.' },
      );
      if (result.ok) await reloadTournaments();
    },
    [secret, tournament, draft, busy, logout, reloadTournaments],
  );

  /**
   * Creates the next tournament and selects it.
   *
   * @param event The form submission.
   */
  const createTournament = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!secret || busy) return;

      setBusy('create');
      const result = await adminFetch<{ tournament: Tournament }>('/api/admin/tournaments', secret, {
        method: 'POST',
        body: {
          title: createDraft.title,
          entry_fee: Math.round(Number(createDraft.entry_fee_cedis) * 100),
          max_players: Number(createDraft.max_players),
          registration_deadline: fromLocalInput(createDraft.registration_deadline),
          match_deadline: fromLocalInput(createDraft.match_deadline),
        },
      });
      setBusy(null);

      if (result.status === 401) {
        logout();
        return;
      }

      if (result.ok && result.data) {
        setBanner({ tone: 'ok', text: 'Tournament created — players can register now.' });
        await reloadTournaments();
        selectTournament(result.data.tournament.id);
      } else {
        setBanner({ tone: 'error', text: result.error ?? 'That did not work. Try again.' });
      }
    },
    [secret, busy, createDraft, logout, reloadTournaments, selectTournament],
  );

  // Nothing exists yet — jump straight to the create form.
  if (tournaments.length === 0) {
    return (
      <div className="flex max-w-xl flex-col gap-4">
        <div>
          <h1 className="text-xl font-extrabold sm:text-2xl">Create the first tournament</h1>
          <p className="mt-1 text-sm text-slate-400">
            One row is all the homepage needs to start taking registrations.
          </p>
        </div>
        {banner ? <Banner tone={banner.tone}>{banner.text}</Banner> : null}
        <CreateForm
          draft={createDraft}
          onChange={onCreateChange}
          onSubmit={(event) => void createTournament(event)}
          busy={busy === 'create'}
        />
      </div>
    );
  }

  if (!tournament) {
    return <p className="text-sm font-medium text-slate-400">Pick a tournament first.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* --- Edit the selected tournament ---------------------------------- */}
      <section aria-labelledby="edit-heading" className="flex max-w-xl flex-col gap-3">
        <div>
          <h1 id="edit-heading" className="text-xl font-extrabold sm:text-2xl">
            Tournament settings
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {tournament.title} · {formatCedis(tournament.entry_fee)} entry · status{' '}
            <span className="font-semibold text-slate-300">{tournament.status}</span>
          </p>
        </div>

        {banner ? <Banner tone={banner.tone}>{banner.text}</Banner> : null}
        {locks.all ? <Banner tone="error">{locks.all}</Banner> : null}

        <form onSubmit={(event) => void saveEdit(event)} className="card flex flex-col gap-3">
          <Field
            id="edit-title"
            label="Title"
            required
            minLength={3}
            maxLength={80}
            disabled={Boolean(locks.all)}
            value={draft.title}
            onChange={(event) => onDraftChange({ title: event.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              id="edit-fee"
              label="Entry fee (GH₵)"
              type="number"
              inputMode="decimal"
              min={1}
              max={1000}
              step="0.5"
              required
              disabled={Boolean(locks.all || locks.fee)}
              locked={locks.fee || undefined}
              value={draft.entry_fee_cedis}
              onChange={(event) => onDraftChange({ entry_fee_cedis: event.target.value })}
            />
            <Field
              id="edit-max"
              label="Max players"
              type="number"
              inputMode="numeric"
              required
              list="supported-sizes"
              disabled={Boolean(locks.all)}
              value={draft.max_players}
              onChange={(event) => onDraftChange({ max_players: event.target.value })}
            />
            <datalist id="supported-sizes">
              {SUPPORTED_SIZES.map((size) => (
                <option key={size} value={size} />
              ))}
            </datalist>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              id="edit-registration-deadline"
              label="Registration closes"
              type="datetime-local"
              required
              disabled={Boolean(locks.all)}
              value={draft.registration_deadline}
              onChange={(event) => onDraftChange({ registration_deadline: event.target.value })}
            />
            <Field
              id="edit-match-deadline"
              label="Matches due by"
              type="datetime-local"
              required
              disabled={Boolean(locks.all)}
              value={draft.match_deadline}
              onChange={(event) => onDraftChange({ match_deadline: event.target.value })}
            />
          </div>
          <button
            type="submit"
            className="btn-primary"
            disabled={busy !== null || Boolean(locks.all)}
          >
            {busy === 'patch' ? 'Saving…' : 'Save changes'}
          </button>
        </form>

        <p className="text-xs leading-relaxed text-slate-500">
          Current deadlines: registration {formatDateTime(tournament.registration_deadline)},
          matches {formatDateTime(tournament.match_deadline)}. Status changes live on the Overview
          tab.
        </p>
      </section>

      {/* --- Create the next tournament -------------------------------------- */}
      <section aria-labelledby="create-heading" className="flex max-w-xl flex-col gap-3">
        <div>
          <h2 id="create-heading" className="text-lg font-bold">
            Start the next tournament
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            The new cup opens immediately and becomes the one the homepage advertises (the newest
            unfinished tournament wins).
          </p>
        </div>
        <CreateForm
          draft={createDraft}
          onChange={onCreateChange}
          onSubmit={(event) => void createTournament(event)}
          busy={busy === 'create'}
        />
      </section>
    </div>
  );
}
