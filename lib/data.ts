/**
 * Server-side data access for Module 1.
 *
 * Everything here runs on the server (React Server Components or API routes)
 * with the service-role key. Every function degrades gracefully: if Supabase is
 * not configured yet, or a query fails, it returns `null`/zero values so the UI
 * can show a friendly message instead of crashing.
 *
 * Module 2 and Module 3 will add their own loaders to this file (groups,
 * standings, brackets); Module 1 only needs tournaments and player counts.
 */

import type { Tournament } from '@/types';
import { isSupabaseConfigured, supabaseAdmin } from './supabase';

/**
 * Loads the tournament the landing page should advertise.
 *
 * Preference order:
 * 1. the most recently created tournament that is not finished,
 * 2. otherwise the most recently created tournament.
 *
 * @returns The tournament, or null when none exists / Supabase is not set up.
 */
export async function getActiveTournament(): Promise<Tournament | null> {
  if (!isSupabaseConfigured()) return null;

  try {
    const supabase = supabaseAdmin();

    const { data: active } = await supabase
      .from('tournaments')
      .select('*')
      .neq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (active) return active as Tournament;

    const { data: latest } = await supabase
      .from('tournaments')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return (latest as Tournament) ?? null;
  } catch (error) {
    console.error('[data.getActiveTournament]', error);
    return null;
  }
}

/**
 * Loads a single tournament by id.
 *
 * @param tournamentId The tournament's UUID.
 * @returns The tournament, or null when it does not exist.
 */
export async function getTournamentById(
  tournamentId: string,
): Promise<Tournament | null> {
  if (!isSupabaseConfigured() || !tournamentId) return null;

  try {
    const supabase = supabaseAdmin();
    const { data } = await supabase
      .from('tournaments')
      .select('*')
      .eq('id', tournamentId)
      .maybeSingle();

    return (data as Tournament) ?? null;
  } catch (error) {
    console.error('[data.getTournamentById]', error);
    return null;
  }
}

/**
 * Counts a tournament's registrations, split by payment status.
 *
 * The landing page shows "6 / 8 registered", and the registration API uses the
 * same numbers to decide whether the tournament is full.
 *
 * @param tournamentId The tournament's UUID.
 * @returns `{ paid, pending, failed, total }` — all zeros on failure.
 */
export async function getRegistrationCounts(tournamentId: string): Promise<{
  paid: number;
  pending: number;
  failed: number;
  total: number;
}> {
  const empty = { paid: 0, pending: 0, failed: 0, total: 0 };
  if (!isSupabaseConfigured() || !tournamentId) return empty;

  try {
    const supabase = supabaseAdmin();
    const { data } = await supabase
      .from('registrations')
      .select('payment_status')
      .eq('tournament_id', tournamentId);

    const rows = (data ?? []) as Array<{ payment_status: string }>;

    return {
      paid: rows.filter((row) => row.payment_status === 'paid').length,
      pending: rows.filter((row) => row.payment_status === 'pending').length,
      failed: rows.filter((row) => row.payment_status === 'failed').length,
      total: rows.length,
    };
  } catch (error) {
    console.error('[data.getRegistrationCounts]', error);
    return empty;
  }
}
