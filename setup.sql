-- =============================================================================
-- DLS TOURNAMENT PLATFORM — SETUP.SQL   (run once, before Module 1)
-- =============================================================================
-- HOW TO RUN THIS
--   1. Open your project at https://supabase.com
--   2. Go to SQL Editor → New query
--   3. Paste this whole file and click RUN
--
-- It is safe to run more than once: every statement either uses
-- "if not exists" or is dropped and recreated first.
--
-- NOTE: the same schema also ships as a Supabase migration at
--   supabase/migrations/20260923000000_initial_schema.sql
-- which the Supabase GitHub integration applies automatically. If you change
-- anything below, change that file too.
--
-- What this file creates:
--   1. The 7 tables of the platform (tournaments + all Module 2 & 3 tables, so
--      the schema is complete before you start building)
--   2. `mark_registration_paid()` — the atomic, capacity-checked function the
--      server uses to turn a verified Paystack payment into a 'paid' slot
--   3. Indexes on the columns the app actually queries
--   4. Row Level Security (RLS) policies: the public may READ public data and
--      INSERT a pending registration (pending only — never 'paid'), and may
--      never update or delete anything
--   5. A public Storage bucket for match screenshots (used from Module 2)
--   6. One starter tournament row (GH₵10 entry, 8 players max)
-- =============================================================================


-- =============================================================================
-- 0. EXTENSIONS
-- =============================================================================
-- gen_random_uuid() powers the `uuid default gen_random_uuid()` primary keys.
create extension if not exists "pgcrypto";


-- =============================================================================
-- 1. TABLES
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1.1 tournaments — one row per tournament
-- ----------------------------------------------------------------------------
create table if not exists public.tournaments (
  id                    uuid default gen_random_uuid() primary key,
  title                 text not null,
  -- Entry fee in PESEWAS (Paystack's smallest unit). GH₵10 = 1000.
  entry_fee             integer not null,
  max_players           integer not null default 8,
  registration_deadline timestamptz not null,
  match_deadline        timestamptz not null,
  -- 'open' | 'closed' | 'groups_drawn' | 'bracket_drawn' | 'completed'
  status                text default 'open',
  created_at            timestamptz default now()
);

-- Keep the status values honest, so a typo can never break the tournament flow.
do $$ begin
  alter table public.tournaments
    add constraint tournaments_status_check
    check (status in ('open','closed','groups_drawn','bracket_drawn','completed'));
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- 1.2 registrations — one row per player who registers
-- ----------------------------------------------------------------------------
create table if not exists public.registrations (
  id                 uuid default gen_random_uuid() primary key,
  tournament_id      uuid references public.tournaments(id) on delete cascade,
  player_name        text not null,
  phone_number       text not null,
  momo_number        text not null,
  dls_team_name      text not null,
  -- Paystack reference. Unique, so one payment can never register two players.
  paystack_reference text unique not null,
  -- 'pending' | 'paid' | 'failed'
  -- ('failed' is an addition to the brief: it lets a declined payment be
  --  recognised, shown to the player, and retried on the same phone number.)
  payment_status     text default 'pending',
  created_at         timestamptz default now()
);

do $$ begin
  alter table public.registrations
    add constraint registrations_payment_status_check
    check (payment_status in ('pending','paid','failed'));
exception when duplicate_object then null; end $$;

-- One phone number may only register ONCE per tournament.
-- This is the database-level guarantee behind "You are already registered".
create unique index if not exists registrations_unique_phone_per_tournament
  on public.registrations (tournament_id, phone_number);

-- ----------------------------------------------------------------------------
-- 1.3 groups — 'A' | 'B' | 'C' | 'D'         (used from Module 2)
-- ----------------------------------------------------------------------------
create table if not exists public.groups (
  id            uuid default gen_random_uuid() primary key,
  tournament_id uuid references public.tournaments(id) on delete cascade,
  group_name    text not null,
  created_at    timestamptz default now()
);

create unique index if not exists groups_unique_name_per_tournament
  on public.groups (tournament_id, group_name);

-- ----------------------------------------------------------------------------
-- 1.4 group_members — which player is in which group   (used from Module 2)
-- ----------------------------------------------------------------------------
create table if not exists public.group_members (
  id            uuid default gen_random_uuid() primary key,
  group_id      uuid references public.groups(id) on delete cascade,
  tournament_id uuid references public.tournaments(id) on delete cascade,
  player_id     uuid references public.registrations(id) on delete cascade,
  created_at    timestamptz default now()
);

create unique index if not exists group_members_unique_player
  on public.group_members (group_id, player_id);

-- ----------------------------------------------------------------------------
-- 1.5 group_matches — round robin fixtures and results  (used from Module 2)
-- ----------------------------------------------------------------------------
create table if not exists public.group_matches (
  id                  uuid default gen_random_uuid() primary key,
  group_id            uuid references public.groups(id) on delete cascade,
  tournament_id       uuid references public.tournaments(id) on delete cascade,
  match_number        integer not null,
  player_a_id         uuid references public.registrations(id) on delete cascade,
  player_b_id         uuid references public.registrations(id) on delete cascade,
  player_a_score      integer default null,
  player_b_score      integer default null,
  player_a_screenshot text default null,
  player_b_screenshot text default null,
  winner_id           uuid references public.registrations(id) on delete set null default null,
  -- 'pending' | 'completed' | 'disputed'
  status              text default 'pending',
  created_at          timestamptz default now()
);

do $$ begin
  alter table public.group_matches
    add constraint group_matches_status_check
    check (status in ('pending','completed','disputed'));
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- 1.6 group_standings — auto-calculated league table    (used from Module 2)
-- ----------------------------------------------------------------------------
create table if not exists public.group_standings (
  id              uuid default gen_random_uuid() primary key,
  group_id        uuid references public.groups(id) on delete cascade,
  tournament_id   uuid references public.tournaments(id) on delete cascade,
  player_id       uuid references public.registrations(id) on delete cascade,
  played          integer default 0,
  won             integer default 0,
  drawn           integer default 0,
  lost            integer default 0,
  goals_for       integer default 0,
  goals_against   integer default 0,
  goal_difference integer default 0,
  points          integer default 0,
  -- Win = 3, Draw = 1, Loss = 0. Recalculated after every match result.
  created_at      timestamptz default now()
);

create unique index if not exists group_standings_unique_player
  on public.group_standings (group_id, player_id);

-- ----------------------------------------------------------------------------
-- 1.7 brackets — knockout matches                       (used from Module 3)
-- ----------------------------------------------------------------------------
create table if not exists public.brackets (
  id                  uuid default gen_random_uuid() primary key,
  tournament_id       uuid references public.tournaments(id) on delete cascade,
  round               integer not null,   -- 1 = semifinals, 2 = grand final
  match_number        integer not null,   -- 1 = first match of that round
  player_a_id         uuid references public.registrations(id) on delete cascade,
  player_b_id         uuid references public.registrations(id) on delete cascade,
  -- While a match is 'pending' this column may hold the FIRST player's claim,
  -- so the second player's claim can be compared with it. It is only shown to
  -- players once status = 'completed'.
  winner_id           uuid references public.registrations(id) on delete set null default null,
  player_a_screenshot text default null,
  player_b_screenshot text default null,
  -- 'pending' | 'completed' | 'disputed'
  status              text default 'pending',
  created_at          timestamptz default now()
);

do $$ begin
  alter table public.brackets
    add constraint brackets_status_check
    check (status in ('pending','completed','disputed'));
exception when duplicate_object then null; end $$;

create unique index if not exists brackets_unique_match
  on public.brackets (tournament_id, round, match_number);


-- ----------------------------------------------------------------------------
-- 1.8 mark_registration_paid — the ONLY way a registration becomes 'paid'
-- ----------------------------------------------------------------------------
-- Called by the server (service role) from `lib/paystack.ts` AFTER Paystack has
-- independently confirmed the money. It exists so a full tournament can never
-- be oversold by two payments confirming at the same time:
--
--   * `select ... for update` on the registration and then the tournament row
--     serialises concurrent claims per tournament (the lock is held to commit),
--   * the paid count is checked against max_players under that lock,
--   * marking 'paid' and storing the verified reference happens in the same
--     transaction.
--
-- Returns:
--   true  → the registration is now 'paid' (or already was — idempotent)
--   false → the tournament is full; the row was left untouched and the caller
--           must tell the player their money will be refunded.
--
-- SECURITY: this function bypasses RLS (security definer), so it must never be
-- callable by the public. It is locked down to the service role immediately.
-- ----------------------------------------------------------------------------
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


-- =============================================================================
-- 2. INDEXES — the columns the app filters on every page load
-- =============================================================================
create index if not exists registrations_tournament_idx
  on public.registrations (tournament_id, payment_status);
create index if not exists group_members_tournament_idx
  on public.group_members (tournament_id);
create index if not exists group_matches_tournament_idx
  on public.group_matches (tournament_id);
create index if not exists group_standings_tournament_idx
  on public.group_standings (tournament_id);
create index if not exists brackets_tournament_idx
  on public.brackets (tournament_id);


-- =============================================================================
-- 3. ROW LEVEL SECURITY
-- =============================================================================
-- The rule is simple: the public can READ public tournament data and can INSERT
-- a registration. Nothing else. Every other write (marking a payment paid,
-- drawing groups, saving results) happens on the server with the SERVICE ROLE
-- key, which bypasses RLS by design.
--
-- ⚠️ IMPORTANT: the service_role key must only ever live in the server-side
-- environment variables (SUPABASE_SERVICE_ROLE_KEY). Never prefix it with
-- NEXT_PUBLIC_ and never import the admin client into a browser component.

alter table public.tournaments     enable row level security;
alter table public.registrations   enable row level security;
alter table public.groups          enable row level security;
alter table public.group_members   enable row level security;
alter table public.group_matches   enable row level security;
alter table public.group_standings enable row level security;
alter table public.brackets        enable row level security;

-- ----------------------------------------------------------------------------
-- tournaments: public read only (the landing page reads the next tournament)
-- ----------------------------------------------------------------------------
drop policy if exists "Public can read tournaments" on public.tournaments;
create policy "Public can read tournaments"
  on public.tournaments for select
  using (true);

-- ----------------------------------------------------------------------------
-- registrations: public INSERT only — no public read, ever.
-- Phone numbers, MoMo numbers and Paystack references stay private.
--
-- The check is the security boundary, so it is deliberately strict:
--   1. payment_status must be 'pending' — an anonymous caller must never be
--      able to insert themselves as 'paid' and skip Paystack (with a plain
--      `check (true)` the anon key could do exactly that). Only the server,
--      through Paystack verification (see mark_registration_paid below),
--      can set 'paid'.
--   2. the tournament must exist, be 'open' and inside its deadline — the
--      same rule /api/register enforces in the app.
-- ----------------------------------------------------------------------------
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

-- (The check above is the hardening that used to be optional: payment_status is
--  forced to 'pending' and the tournament must be open. /api/register creates
--  the registration BEFORE payment, so this stays compatible — registration
--  always happens while the tournament is open, and the service-role client
--  the server uses bypasses RLS entirely.)

-- ----------------------------------------------------------------------------
-- Everything else: public read only.
-- ----------------------------------------------------------------------------
drop policy if exists "Public can read groups" on public.groups;
create policy "Public can read groups"
  on public.groups for select using (true);

drop policy if exists "Public can read group_members" on public.group_members;
create policy "Public can read group_members"
  on public.group_members for select using (true);

drop policy if exists "Public can read group_matches" on public.group_matches;
create policy "Public can read group_matches"
  on public.group_matches for select using (true);

drop policy if exists "Public can read group_standings" on public.group_standings;
create policy "Public can read group_standings"
  on public.group_standings for select using (true);

drop policy if exists "Public can read brackets" on public.brackets;
create policy "Public can read brackets"
  on public.brackets for select using (true);

-- There are deliberately NO public update or delete policies anywhere.


-- =============================================================================
-- 4. STORAGE — screenshot bucket (used from Module 2, created now)
-- =============================================================================
-- Players upload a screenshot of the final scoreboard as proof of their result.
insert into storage.buckets (id, name, public)
values ('result-screenshots', 'result-screenshots', true)
on conflict (id) do nothing;

-- Anyone can view a screenshot (paths are random UUIDs, so they are unguessable).
drop policy if exists "Public can view screenshots" on storage.objects;
create policy "Public can view screenshots"
  on storage.objects for select
  using (bucket_id = 'result-screenshots');

-- Anyone can upload a screenshot: images only, 5MB maximum, and the storage
-- path must have the shape the app writes — result-screenshots/<tournament
-- uuid>/<match uuid>/<name>.<jpg|jpeg|png|webp> — so the bucket cannot be
-- used as arbitrary anonymous file storage.
drop policy if exists "Public can upload screenshots" on storage.objects;
create policy "Public can upload screenshots"
  on storage.objects for insert
  with check (
    bucket_id = 'result-screenshots'
    and coalesce(metadata->>'mimetype', '') like 'image/%'
    and coalesce((metadata->>'size')::bigint, 0) between 1 and 5242880
    and name ~* '^result-screenshots/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-z-]+\.(jpg|jpeg|png|webp)$'
  );


-- =============================================================================
-- 5. STARTER TOURNAMENT
-- =============================================================================
-- Inserts one tournament ONLY if the table is empty, so re-running this file
-- never creates duplicates.
--
-- Defaults: GH₵10 entry (1000 pesewas), 8 players max, registration closes in
-- 7 days, matches must finish within 14 days.
--
-- To change the entry fee or dates later, edit the row directly:
--   Supabase Dashboard -> Table Editor -> tournaments
insert into public.tournaments
  (title, entry_fee, max_players, registration_deadline, match_deadline, status)
select
  'DLS Champions Cup #1',
  1000,
  8,
  now() + interval '7 days',
  now() + interval '14 days',
  'open'
where not exists (select 1 from public.tournaments);

-- =============================================================================
-- DONE ✅
-- Next steps for Module 1:
--   1. Copy .env.example to .env.local and fill in your keys
--   2. Run `npm run dev` and open http://localhost:3000
--   3. Register as a player and pay with a Paystack TEST card/momo number
-- =============================================================================
