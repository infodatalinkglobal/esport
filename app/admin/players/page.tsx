'use client';

/**
 * /admin/players — the Players tab (MODULE 4).
 *
 * The organizer's private phone book AND payments desk for one tournament:
 *   - every registration with contact details and a search box,
 *   - one-tap manual "Mark paid" (for MoMo paid outside Paystack),
 *   - refunds: via Paystack's refund API, or "mark refunded" for manual MoMo,
 *   - inline editing of a player's details (name, team, numbers),
 *   - a broadcast composer: pick recipients, write one message, copy it with
 *     the contacts for WhatsApp (browsers cannot open a true multi-recipient
 *     WhatsApp broadcast, so copy-and-paste is the honest mechanism),
 *   - CSV export of the whole list.
 *
 * The data comes from /api/admin/registrations — the only endpoint that may
 * ship phone numbers, MoMo numbers and Paystack references to a browser.
 */

import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { AdminRegistrationRow, PaymentStatus } from '@/types';
import { useAdmin } from '@/components/admin/admin-context';
import { Banner, ConfirmButton, PaymentBadge } from '@/components/admin/ui';
import { adminFetch, copyToClipboard, downloadCsv } from '@/lib/admin-client';

/** The edit form's draft (one row is open at a time). */
interface EditDraft {
  player_name: string;
  dls_team_name: string;
  phone_number: string;
  momo_number: string;
}

/** A wa.me deep link from a local 0XX number. */
function waLink(phoneNumber: string, message?: string): string {
  const international = phoneNumber.replace(/^0/, '233').replace(/\D/g, '');
  return `https://wa.me/${international}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
}

/**
 * The Players page.
 *
 * @returns The broadcast composer and the searchable registrations table.
 */
export default function AdminPlayersPage() {
  const { secret, selectedId, tournaments, logout } = useAdmin();
  const [rows, setRows] = useState<AdminRegistrationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // --- Broadcast composer state -------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');

  // --- Edit state -----------------------------------------------------------
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);

  /** The selected tournament's row (for the payment-freeze rules). */
  const tournament = useMemo(
    () => tournaments.find((item) => item.tournament.id === selectedId)?.tournament ?? null,
    [tournaments, selectedId],
  );

  /** True while the tournament can still change who is in it (no draw yet). */
  const paymentsOpen =
    tournament?.status === 'open' || tournament?.status === 'closed';

  /** (Re)loads the registrations. */
  const load = useCallback(async () => {
    if (!secret || !selectedId) return;
    setLoading(true);
    const result = await adminFetch<{ registrations: AdminRegistrationRow[] }>(
      `/api/admin/registrations?tournament_id=${encodeURIComponent(selectedId)}`,
      secret,
    );
    setLoading(false);

    if (result.status === 401) {
      logout();
      return;
    }
    if (!result.ok || !result.data) {
      setFailed(result.error ?? 'The players could not be loaded.');
      return;
    }
    setFailed(null);
    setRows(result.data.registrations);
    setSelected(new Set());
  }, [secret, selectedId, logout]);

  useEffect(() => {
    setRows([]);
    void load();
  }, [load]);

  // A sensible default broadcast once the tournament is known.
  useEffect(() => {
    if (tournament && !message) {
      setMessage(
        `Hi! Quick update about ${tournament.title}: registration closes soon and matches must be played before the deadline. — DLS Tournament GH`,
      );
    }
  }, [tournament, message]);

  /** The rows matching the search box (name, team, phone or reference). */
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      [row.player_name, row.dls_team_name, row.phone_number, row.paystack_reference]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [rows, query]);

  const paid = rows.filter((row) => row.payment_status === 'paid').length;

  /**
   * Manually confirms one player's payment.
   *
   * @param registrationId The registration to mark paid.
   */
  async function markPaid(registrationId: string) {
    if (!secret) return;
    setBusyId(registrationId);
    const result = await adminFetch('/api/admin/registrations/mark-paid', secret, {
      method: 'POST',
      body: { registration_id: registrationId },
    });
    setBusyId(null);

    if (result.status === 401) {
      logout();
      return;
    }

    if (result.ok) {
      setBanner({ tone: 'ok', text: 'Payment confirmed — the player is in.' });
      await load();
    } else {
      setBanner({ tone: 'error', text: result.error ?? 'That did not work. Try again.' });
    }
  }

  /**
   * Refunds one player (Paystack mode when asked, manual otherwise).
   *
   * @param registrationId The registration to refund.
   * @param mode 'paystack' asks Paystack to return the money; 'manual' only
   *             records a refund already handed over by MoMo.
   */
  async function refund(registrationId: string, mode: 'paystack' | 'manual') {
    if (!secret) return;
    setBusyId(registrationId);
    const result = await adminFetch('/api/admin/registrations/refund', secret, {
      method: 'POST',
      body: { registration_id: registrationId, mode },
    });
    setBusyId(null);

    if (result.status === 401) {
      logout();
      return;
    }

    if (result.ok) {
      setBanner({
        tone: 'ok',
        text: mode === 'paystack' ? 'Paystack refund queued — the slot is free again.' : 'Marked refunded — the slot is free again.',
      });
      await load();
    } else {
      setBanner({ tone: 'error', text: result.error ?? 'That did not work. Try again.' });
    }
  }

  /**
   * Opens the inline edit form for one row.
   *
   * @param row The registration being edited.
   */
  function startEdit(row: AdminRegistrationRow) {
    setEditId(row.id);
    setEditDraft({
      player_name: row.player_name,
      dls_team_name: row.dls_team_name,
      phone_number: row.phone_number,
      momo_number: row.momo_number,
    });
  }

  /**
   * Saves the inline edit form.
   *
   * @param event The form submission.
   */
  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!secret || !editId || !editDraft || busyId) return;
    setBusyId(editId);
    const result = await adminFetch('/api/admin/registrations', secret, {
      method: 'PATCH',
      body: { id: editId, ...editDraft },
    });
    setBusyId(null);

    if (result.status === 401) {
      logout();
      return;
    }

    if (result.ok) {
      setBanner({ tone: 'ok', text: 'Player details updated.' });
      setEditId(null);
      await load();
    } else {
      setBanner({ tone: 'error', text: result.error ?? 'That did not work. Try again.' });
    }
  }

  /** Toggles one row's broadcast selection. */
  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Selects/deselects every visible row of one payment status. */
  function selectByStatus(status: PaymentStatus | 'all') {
    setSelected((current) => {
      const next = new Set(current);
      const targets = filtered.filter(
        (row) => status === 'all' || row.payment_status === status,
      );
      const allSelected = targets.every((row) => next.has(row.id));
      targets.forEach((row) => (allSelected ? next.delete(row.id) : next.add(row.id)));
      return next;
    });
  }

  /** Copies the broadcast message with the selected contacts. */
  async function copyBroadcast() {
    const recipients = rows.filter((row) => selected.has(row.id));
    if (recipients.length === 0) return;

    const text =
      `📤 Broadcast — ${tournament?.title ?? 'tournament'} (${recipients.length} recipients)\n\n` +
      `Message:\n${message.trim()}\n\n` +
      'Recipients (WhatsApp):\n' +
      recipients.map((row) => `• ${row.player_name} — +${row.phone_number.replace(/^0/, '233')}`).join('\n');

    const ok = await copyToClipboard(text);
    setBanner(
      ok
        ? { tone: 'ok', text: `Copied — paste it into WhatsApp for ${recipients.length} player(s).` }
        : { tone: 'error', text: 'Could not reach the clipboard. Select the text manually.' },
    );
  }

  /** Exports the full registration list as CSV. */
  function exportCsv() {
    downloadCsv(
      `players-${tournament?.title?.replace(/[^\w-]+/g, '-').toLowerCase() ?? 'tournament'}.csv`,
      rows.map((row) => ({
        name: row.player_name,
        dls_team: row.dls_team_name,
        whatsapp: row.phone_number,
        momo: row.momo_number,
        payment_status: row.payment_status,
        paystack_reference: row.paystack_reference,
        registered: row.registered_at,
      })),
    );
  }

  if (!selectedId && !loading) {
    return (
      <div className="acard">
        <h1 className="text-lg font-bold text-slate-900">No tournament selected</h1>
        <p className="mt-1 text-sm text-slate-600">Pick a tournament in the header first.</p>
      </div>
    );
  }

  if (loading) {
    return <p className="text-sm font-medium text-slate-500">Loading the players…</p>;
  }

  if (failed) {
    return (
      <div className="flex flex-col gap-3">
        <Banner tone="error">{failed}</Banner>
        <button type="button" className="abtn-secondary max-w-xs" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-slate-900 sm:text-2xl">Players</h1>
          <p className="mt-1 text-sm text-slate-600">
            {paid} paid of {rows.length} registered
            {paymentsOpen ? '' : ' — the groups are drawn, payments are frozen'}
          </p>
        </div>
        <div className="flex w-full max-w-xs items-center gap-2">
          <div className="flex-1">
            <label htmlFor="player-search" className="sr-only">
              Search players
            </label>
            <input
              id="player-search"
              type="search"
              className="afield py-2 text-sm"
              placeholder="Search name, team, phone…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={exportCsv}
            className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm hover:bg-slate-50"
          >
            ⬇ CSV
          </button>
        </div>
      </div>

      {banner ? <Banner tone={banner.tone}>{banner.text}</Banner> : null}

      {/* --- Broadcast composer ------------------------------------------ */}
      <section aria-labelledby="broadcast-heading" className="acard flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="broadcast-heading" className="text-sm font-bold uppercase tracking-wide text-slate-500">
            📤 Broadcast to players
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {(['all', 'paid', 'pending'] as const).map((group) => (
              <button
                key={group}
                type="button"
                onClick={() => selectByStatus(group)}
                className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                {group === 'all' ? 'Select all' : `Select ${group}`}
              </button>
            ))}
          </div>
        </div>
        <label htmlFor="broadcast-message" className="afield-label">
          Message ({selected.size} selected)
        </label>
        <textarea
          id="broadcast-message"
          className="afield min-h-24"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            className="abtn-primary sm:flex-1"
            disabled={selected.size === 0 || !message.trim()}
            onClick={() => void copyBroadcast()}
          >
            Copy for WhatsApp ({selected.size})
          </button>
          <p className="text-xs leading-snug text-slate-500 sm:max-w-xs">
            Copies the message with every selected contact — paste it into WhatsApp chats
            (browsers cannot open a true multi-recipient broadcast).
          </p>
        </div>
      </section>

      {/* --- The table ------------------------------------------------------ */}
      <div className="acard overflow-x-auto p-0">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <th scope="col" className="w-10 px-3 py-3">
                <span className="sr-only">Select for broadcast</span>
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">Player</th>
              <th scope="col" className="px-4 py-3 font-semibold">DLS team</th>
              <th scope="col" className="px-4 py-3 font-semibold">WhatsApp</th>
              <th scope="col" className="px-4 py-3 font-semibold">MoMo</th>
              <th scope="col" className="px-4 py-3 font-semibold">Payment</th>
              <th scope="col" className="px-4 py-3 font-semibold">Reference</th>
              <th scope="col" className="w-52 px-4 py-3 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                  {rows.length === 0 ? 'No registrations yet.' : 'Nothing matches that search.'}
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <Fragment key={row.id}>
                  <tr className="border-b border-slate-100 align-top">
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.player_name} for broadcast`}
                        className="h-5 w-5 accent-pitch-600"
                        checked={selected.has(row.id)}
                        onChange={() => toggleSelected(row.id)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-900">{row.player_name}</p>
                      <p className="text-xs text-slate-500">{row.registered_at}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{row.dls_team_name}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">
                      <a
                        className="underline decoration-slate-300 underline-offset-2 hover:text-pitch-700"
                        href={waLink(row.phone_number, message.trim() || undefined)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {row.phone_number}
                      </a>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-500">{row.momo_number}</td>
                    <td className="px-4 py-3">
                      <PaymentBadge status={row.payment_status} />
                    </td>
                    <td className="px-4 py-3">
                      <span className="break-all font-mono text-xs text-slate-500">
                        {row.paystack_reference}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1.5">
                        {row.payment_status === 'paid' ? (
                          paymentsOpen ? (
                            <ConfirmButton
                              label="Refund"
                              confirmLabel="Refund via Paystack?"
                              danger
                              busy={busyId === row.id}
                              onConfirm={() => void refund(row.id, 'paystack')}
                            />
                          ) : (
                            <span className="text-xs text-slate-500">In the draw</span>
                          )
                        ) : row.payment_status === 'pending' ? (
                          paymentsOpen ? (
                            <ConfirmButton
                              label="Mark paid"
                              confirmLabel="Confirm payment?"
                              busy={busyId === row.id}
                              onConfirm={() => void markPaid(row.id)}
                            />
                          ) : (
                            <span className="text-xs text-slate-500">Frozen</span>
                          )
                        ) : (
                          <span className="text-xs text-slate-500">
                            {row.payment_status === 'refunded' ? 'Money returned' : 'Never paid'}
                          </span>
                        )}
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            className="text-xs font-semibold text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-800"
                            onClick={() =>
                              editId === row.id ? setEditId(null) : startEdit(row)
                            }
                          >
                            {editId === row.id ? 'Close' : 'Edit'}
                          </button>
                          {row.payment_status === 'paid' && paymentsOpen && (
                            <button
                              type="button"
                              className="text-xs font-semibold text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-800"
                              title="Record a refund you already handed over by MoMo"
                              onClick={() => void refund(row.id, 'manual')}
                            >
                              Mark refunded
                            </button>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                  {editId === row.id && editDraft ? (
                    <tr className="border-b border-slate-100 bg-slate-50">
                      <td colSpan={8} className="px-4 py-4">
                        <form onSubmit={(event) => void saveEdit(event)} className="flex flex-col gap-3">
                          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                            Edit player details
                          </p>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <label>
                              <span className="afield-label text-xs">Player name</span>
                              <input
                                className="afield py-2 text-sm"
                                required
                                value={editDraft.player_name}
                                onChange={(event) =>
                                  setEditDraft((draft) =>
                                    draft ? { ...draft, player_name: event.target.value } : draft,
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span className="afield-label text-xs">DLS team</span>
                              <input
                                className="afield py-2 text-sm"
                                required
                                value={editDraft.dls_team_name}
                                onChange={(event) =>
                                  setEditDraft((draft) =>
                                    draft ? { ...draft, dls_team_name: event.target.value } : draft,
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span className="afield-label text-xs">WhatsApp number</span>
                              <input
                                className="afield py-2 text-sm"
                                type="tel"
                                required
                                value={editDraft.phone_number}
                                onChange={(event) =>
                                  setEditDraft((draft) =>
                                    draft ? { ...draft, phone_number: event.target.value } : draft,
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span className="afield-label text-xs">MoMo number</span>
                              <input
                                className="afield py-2 text-sm"
                                type="tel"
                                required
                                value={editDraft.momo_number}
                                onChange={(event) =>
                                  setEditDraft((draft) =>
                                    draft ? { ...draft, momo_number: event.target.value } : draft,
                                  )
                                }
                              />
                            </label>
                          </div>
                          <div className="flex max-w-md gap-2">
                            <button type="submit" className="abtn-primary flex-1" disabled={busyId === row.id}>
                              {busyId === row.id ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              className="abtn-secondary flex-1"
                              onClick={() => setEditId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                          <p className="text-xs text-slate-500">
                            Payment status is not editable here — use Mark paid / Refund, which have
                            their own guard rails.
                          </p>
                        </form>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs leading-relaxed text-slate-500">
        “Mark paid” and refunds use the same capacity-checked paths as real payments — a full
        tournament refuses the extra player, and a refund frees the slot for the next one.
      </p>
    </div>
  );
}
