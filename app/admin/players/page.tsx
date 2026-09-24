'use client';

/**
 * /admin/players — the Players tab (MODULE 4).
 *
 * The organizer's private phone book for one tournament: every registration
 * with contact details, a search box, payment badges, one-tap manual
 * "Mark paid" (for MoMo paid outside Paystack) and a WhatsApp link to nudge
 * whoever is still pending.
 *
 * The data comes from /api/admin/registrations — the only endpoint that may
 * ship phone numbers, MoMo numbers and Paystack references to a browser.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdminRegistrationRow } from '@/types';
import { useAdmin } from '@/components/admin/admin-context';
import { Banner, ConfirmButton, PaymentBadge } from '@/components/admin/ui';
import { adminFetch } from '@/lib/admin-client';

/**
 * The Players page.
 *
 * @returns The searchable registrations table with payment actions.
 */
export default function AdminPlayersPage() {
  const { secret, selectedId, tournaments, logout } = useAdmin();
  const [rows, setRows] = useState<AdminRegistrationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** The selected tournament's row (for the "can still mark paid" rule). */
  const tournament = useMemo(
    () => tournaments.find((item) => item.tournament.id === selectedId)?.tournament ?? null,
    [tournaments, selectedId],
  );

  /** True while the tournament can still accept a manual payment (no draw yet). */
  const canMarkPaid = tournament?.status === 'open' || tournament?.status === 'closed';

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
  }, [secret, selectedId, logout]);

  useEffect(() => {
    setRows([]);
    void load();
  }, [load]);

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

  if (!selectedId && !loading) {
    return (
      <div className="card">
        <h1 className="text-lg font-bold">No tournament selected</h1>
        <p className="mt-1 text-sm text-slate-400">Pick a tournament in the header first.</p>
      </div>
    );
  }

  if (loading) {
    return <p className="text-sm font-medium text-slate-400">Loading the players…</p>;
  }

  if (failed) {
    return (
      <div className="flex flex-col gap-3">
        <Banner tone="error">{failed}</Banner>
        <button type="button" className="btn-secondary max-w-xs" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold sm:text-2xl">Players</h1>
          <p className="mt-1 text-sm text-slate-400">
            {paid} paid of {rows.length} registered
            {canMarkPaid ? '' : ' — the groups are drawn, payments are frozen'}
          </p>
        </div>
        <div className="w-full max-w-xs">
          <label htmlFor="player-search" className="sr-only">
            Search players
          </label>
          <input
            id="player-search"
            type="search"
            className="field py-2 text-sm"
            placeholder="Search name, team, phone…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {banner ? <Banner tone={banner.tone}>{banner.text}</Banner> : null}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[52rem] text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-slate-500">
              <th scope="col" className="px-4 py-3 font-semibold">Player</th>
              <th scope="col" className="px-4 py-3 font-semibold">DLS team</th>
              <th scope="col" className="px-4 py-3 font-semibold">WhatsApp</th>
              <th scope="col" className="px-4 py-3 font-semibold">MoMo</th>
              <th scope="col" className="px-4 py-3 font-semibold">Payment</th>
              <th scope="col" className="px-4 py-3 font-semibold">Reference</th>
              <th scope="col" className="px-4 py-3 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                  {rows.length === 0 ? 'No registrations yet.' : 'Nothing matches that search.'}
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr key={row.id} className="border-b border-white/5 last:border-0 align-top">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-200">{row.player_name}</p>
                    <p className="text-xs text-slate-500">{row.registered_at}</p>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{row.dls_team_name}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-300">
                    <a
                      className="underline decoration-white/30 underline-offset-2 hover:text-pitch-300"
                      href={`https://wa.me/${row.phone_number.replace(/^0/, '233').replace(/\D/g, '')}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {row.phone_number}
                    </a>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-400">{row.momo_number}</td>
                  <td className="px-4 py-3">
                    <PaymentBadge status={row.payment_status} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="break-all font-mono text-xs text-slate-500">
                      {row.paystack_reference}
                    </span>
                  </td>
                  <td className="w-44 px-4 py-3">
                    {row.payment_status === 'paid' ? (
                      <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                        In the draw
                      </span>
                    ) : canMarkPaid ? (
                      <ConfirmButton
                        label="Mark paid"
                        confirmLabel="Confirm payment?"
                        busy={busyId === row.id}
                        onConfirm={() => void markPaid(row.id)}
                      />
                    ) : (
                      <span className="text-xs text-slate-600">Frozen</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs leading-relaxed text-slate-500">
        “Mark paid” uses the same capacity-checked database function as a verified Paystack
        payment — a full tournament refuses the extra player instead of overselling the bracket.
      </p>
    </div>
  );
}
