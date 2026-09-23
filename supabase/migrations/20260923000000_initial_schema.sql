-- =============================================================================
-- DLS TOURNAMENT PLATFORM — INITIAL SCHEMA  (Supabase migration)
-- =============================================================================
-- This file is the Supabase-migration twin of `setup.sql` in the repository
-- root. The SQL below is identical — only this header differs.
--
--   setup.sql                                        -> paste into the SQL Editor
--   supabase/migrations/20260923000000_initial_schema.sql -> applied automatically
--
-- WHY THIS FILE EXISTS
--   Supabase's GitHub integration ("Deploy to production") reads ONLY this
--   folder. Every commit to your production branch runs any migration it has
--   not already applied, so schema changes reach the database without anyone
--   copy-pasting SQL by hand.
--
-- SAFE TO RUN TWICE
--   Both files are idempotent: tables use "if not exists", constraints swallow
--   duplicate_object, policies are dropped before being recreated, the storage
--   bucket uses "on conflict do nothing", and the starter tournament is only
--   inserted when the table is empty. Applying this to a database where you
--   already pasted setup.sql is a no-op, not an error.
--
-- ⚠️ KEEPING THEM IN SYNC
--   If you change the schema, change BOTH files. The migration is what new
--   environments get; setup.sql is what you hand to anyone setting up by hand.
--
-- What this file creates:
--   1. The 7 tables of the platform
--   2. Indexes on the columns the app actually queries
--   3. Row Level Security: public READ on public data, INSERT-only on
--      registrations, and no public update or delete anywhere
--   4. A public Storage bucket for match screenshots
--   5. One starter tournament row (GH₵10 entry, 8 players max)
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
-- ----------------------------------------------------------------------------
drop policy if exists "Public can insert registrations" on public.registrations;
create policy "Public can insert registrations"
  on public.registrations for insert
  with check (true);

-- OPTIONAL HARDENING (recommended once you are live): stop anyone from
-- inserting a registration into a closed or full tournament, even if they
-- bypass the app and call the Supabase REST API directly. The app already
-- enforces this in /api/register, so this is a second line of defence.
-- To enable it, uncomment these four lines and run them:
--
-- drop policy if exists "Public can insert registrations" on public.registrations;
-- create policy "Public can insert registrations"
--   on public.registrations for insert
--   with check (
--     exists (
--       select 1 from public.tournaments t
--       where t.id = tournament_id
--         and t.status = 'open'
--         and t.registration_deadline > now()
--     )
--   );
-- (Note: `/api/register` creates the registration BEFORE payment, so this stays
--  compatible — registration always happens while the tournament is open.)

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

-- Anyone can upload a screenshot: images only, 5MB maximum.
drop policy if exists "Public can upload screenshots" on storage.objects;
create policy "Public can upload screenshots"
  on storage.objects for insert
  with check (
    bucket_id = 'result-screenshots'
    and coalesce(metadata->>'mimetype', '') like 'image/%'
    and coalesce((metadata->>'size')::bigint, 0) between 1 and 5242880
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
