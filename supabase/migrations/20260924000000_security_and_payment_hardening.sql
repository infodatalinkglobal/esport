-- =============================================================================
-- 20260924000000 — SECURITY & PAYMENT-INTEGRITY HARDENING
-- =============================================================================
-- For databases that already ran the initial schema (or an older setup.sql):
-- the Supabase GitHub integration applies this automatically; hand-run setups
-- can paste this whole file into Supabase → SQL Editor → Run. Idempotent.
--
-- What it fixes:
--   1. The `registrations` INSERT policy used to accept ANY row, so anyone
--      with the public anon key could insert themselves as payment_status =
--      'paid' and skip Paystack entirely. The policy now forces 'pending' and
--      requires an open tournament, exactly like /api/register.
--   2. Adds `mark_registration_paid()`: the server's single, atomic,
--      capacity-checked way to mark a registration 'paid' after Paystack
--      verifies the money. Two payments confirming at the same instant can no
--      longer oversell a full tournament. Locked down to the service role.
--   3. The screenshot upload policy now requires the storage path to have the
--      exact shape the app writes, so the bucket can't be used as anonymous
--      file storage; the bucket itself limits type (JPG/PNG/WebP) and size
--      (5 MB).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. registrations: only PENDING rows may be inserted by the public
-- -----------------------------------------------------------------------------
drop policy if exists "Public can insert registrations" on public.registrations;
create policy "Public can insert registrations"
  on public.registrations for insert
  with check (
    payment_status = 'pending'
    and exists (
      select 1 from public.tournaments t
      where t.id = tournament_id
        and t.status = 'open'
        and t.registration_deadline > now()
    )
  );

-- -----------------------------------------------------------------------------
-- 2. Atomic, capacity-checked payment claim (called by the server only)
-- -----------------------------------------------------------------------------
create or replace function public.mark_registration_paid(
  p_registration_id uuid,
  p_reference text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_status        text;
  v_max_players   integer;
  v_paid          integer;
begin
  -- 1. Lock the registration row and see what state it is in.
  select tournament_id, payment_status
    into v_tournament_id, v_status
    from public.registrations
    where id = p_registration_id
    for update;

  if not found then
    return false;
  end if;

  -- 2. Already verified earlier — idempotent, nothing left to do.
  if v_status = 'paid' then
    return true;
  end if;

  -- 3. Lock the tournament and enforce the cap. Every payment claim for one
  --    tournament queues on this row lock, so exactly max_players rows can
  --    ever end up 'paid'.
  select max_players
    into v_max_players
    from public.tournaments
    where id = v_tournament_id
    for update;

  select count(*) into v_paid
    from public.registrations
    where tournament_id = v_tournament_id
      and payment_status = 'paid';

  if v_paid >= coalesce(v_max_players, 0) then
    return false;
  end if;

  -- 4. Claim the slot.
  update public.registrations
    set payment_status = 'paid',
        paystack_reference = p_reference
    where id = p_registration_id;

  return true;
end;
$$;

revoke execute on function public.mark_registration_paid(uuid, text) from anon, authenticated;
grant execute on function public.mark_registration_paid(uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- 3. Screenshots: uploads must look like what the app writes
-- -----------------------------------------------------------------------------
-- Corrected on 2026-09-25 (see 20260925120000_fix_screenshot_uploads.sql): the
-- first version of this policy refused every upload. This file now carries the
-- working version too, so hand re-running it can never re-break uploads.
update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'result-screenshots';

drop policy if exists "Public can upload screenshots" on storage.objects;
create policy "Public can upload screenshots"
  on storage.objects for insert
  with check (
    bucket_id = 'result-screenshots'
    and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-z-]+\.(jpg|jpeg|png|webp)$'
  );
