# DLS Tournament GH 🎮 — Ghana's #1 DLS Tournament Platform

A mobile-first Dream League Soccer tournament platform for Ghanaian players.
Players register, pay the entry fee with MoMo through Paystack, get drawn into
groups of four, and fight their way to the Grand Final.

**Format:** groups of 4 → Semifinals → Grand Final (no 3rd place match).

---

## Build status

| Module | Scope | Status |
| --- | --- | --- |
| **Module 1** | Foundation + payments (register, pay, verify) | ✅ Built |
| **Module 2** | Group stage (draw, standings, fixtures, results) | ✅ Built |
| **Module 3** | Knockout stage + deployment | ✅ Built |

All three modules are complete.

---

## 🚀 Setup

### 1. Create the database

1. Create a free project at [supabase.com](https://supabase.com)
2. Open **SQL Editor → New query**
3. Paste the whole of **`setup.sql`** and press **RUN**

This creates all 7 tables, the indexes, the Row Level Security policies, the
`result-screenshots` storage bucket, and one starter tournament
(GH₵10 entry, 8 players). It is safe to re-run.

> **Already connected Supabase to GitHub?** The integration reads **only**
> `supabase/migrations/` — it never looks at `setup.sql`. The identical schema is
> committed at `supabase/migrations/20260923000000_initial_schema.sql`, so switch
> on **Deploy to production** and merge this branch into your production branch
> (`main`) and Supabase applies it for you. Either route works, both are safe to
> run twice, and doing both is harmless. Leave **preview branching** off unless
> you upgrade to Pro — preview branches spawn a database per pull request and are
> billed hourly.
>
> **Already have a live database from before the security hardening?** Also run
> `supabase/migrations/20260924000000_security_and_payment_hardening.sql` once
> (SQL Editor → paste → RUN, or let the GitHub integration apply it). It closes
> a hole that let anyone insert themselves as `paid` with the public anon key,
> adds the atomic capacity-checked `mark_registration_paid()` function the
> server now uses, and tightens the screenshot-upload policy. New setups get
> all of this from `setup.sql` and don't need the extra step.

### 2. Create the Paystack keys

1. Sign up free at [paystack.com](https://paystack.com)
2. **Settings → API Keys & Webhooks** → copy the test keys (`pk_test_…`, `sk_test_…`)

### 3. Configure the environment

```bash
cp .env.example .env.local
```

Fill in every value — `.env.example` says exactly where to find each one.

```env
NEXT_PUBLIC_SUPABASE_URL=…
NEXT_PUBLIC_SUPABASE_ANON_KEY=…
SUPABASE_SERVICE_ROLE_KEY=…
NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY=pk_test_…
PAYSTACK_SECRET_KEY=sk_test_…
NEXT_PUBLIC_TOURNAMENT_ENTRY_FEE=1000     # 1000 pesewas = GH₵10
NEXT_PUBLIC_ORGANIZER_CUT_PERCENT=15
ADMIN_SECRET=…                            # protects the draw endpoints
NEXT_PUBLIC_WHATSAPP_CONTACT=233241234567
NEXT_PUBLIC_WHATSAPP_GROUP_INVITE_URL=…
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

⚠️ `SUPABASE_SERVICE_ROLE_KEY` and `PAYSTACK_SECRET_KEY` must **never** be
prefixed with `NEXT_PUBLIC_`, and never committed. `.env.local` is git-ignored.

### 4. Configure the Paystack webhook

In **Paystack Dashboard → Settings → API Keys & Webhooks**, set the webhook URL
to:

```text
https://YOUR-PRODUCTION-DOMAIN/api/paystack/webhook
```

The webhook has no separate signing-secret setting: Paystack signs it with the
secret key for the dashboard mode receiving the transaction. Therefore the
production Vercel environment must contain the matching pair: `pk_live_…` in
`NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` and `sk_live_…` in `PAYSTACK_SECRET_KEY`.
For test transactions, use the matching `pk_test_…` / `sk_test_…` pair and set
the URL in Paystack's test-mode settings. Never mix test and live keys. The
endpoint verifies the HMAC-SHA512 signature and then independently verifies the
transaction with Paystack before changing a registration.

> **How a payment becomes `paid`:** the server calls the
> `mark_registration_paid()` database function, which locks the tournament row
> while it checks the paid count — so a full tournament can never be oversold,
> even when two payments confirm at the same instant. If the last slot was
> taken first, the loser gets a "we will refund you" message and the row stays
> unpaid. Paystack `ongoing`/`pending` transactions never flip a registration
> to `failed`; only terminal statuses do.

### 5. Run it

```bash
npm install
npm run dev      # http://localhost:3000
```

Scripts: `npm run build`, `npm start`, `npm run typecheck`.

---

## 🏗️ What is in the codebase

### Pages

| Route | What it does |
| --- | --- |
| `/` | Hero, tournament card with live player count + countdown, prize pool, registration form, collapsible rules, WhatsApp footer |
| `/payment/verify` | Shows "Verifying payment…", asks the server to confirm with Paystack, then forwards to the success page |
| `/payment/success` | ✅ confirmation with player name, tournament, match deadline, WhatsApp group + share buttons |
| `/groups/[tournamentId]` | Every group's league table + fixtures, top 2 in green, auto-refreshes every 60 seconds |
| `/bracket/[tournamentId]` | Semifinals and Grand Final as stacked cards, winner in green, champion banner, auto-refreshes every 60 seconds |
| `/submit-result` | Group Match / Knockout Match tabs — knockout opens first once the bracket is drawn |

### API routes

| Route | Notes |
| --- | --- |
| `POST /api/register` | Validates the form, checks open / full / duplicate, creates the `pending` registration |
| `POST /api/paystack/initialize` | Server-side Paystack transaction (amount can't be tampered with); returns the popup code **and** the redirect URL |
| `POST /api/verify-payment` | Confirms the money with Paystack, marks the registration `paid` |
| `POST /api/admin/draw-groups` | 🔒 Recovery fallback: draws the groups by hand (they normally draw themselves when the tournament fills) |
| `POST /api/admin/draw-knockout` | 🔒 Builds the knockout bracket (see below) |
| `POST /api/submit-result` | Records a group or knockout result, auto-confirms when both players agree |

**Why five routes instead of the two in the brief:** the module rules require
server-side checks that the browser cannot do safely (tournament open/full/not
already registered, a tamper-proof payment amount, writing match results past
Row Level Security). All of them use the service-role key on the server only.

### Libraries

| File | Contents |
| --- | --- |
| `lib/supabase.ts` | `supabaseAdmin()` (service role, server only) + `supabase()` (anon, browser) |
| `lib/paystack.ts` | `initializePayment()`, `verifyPayment()`, popup opener with redirect fallback |
| `lib/calculations.ts` | `calculatePrizes()` — 15% cut, 70/30 split, integer pesewas |
| `lib/draw.ts` | `ensureGroupDraw()` — the automatic group draw: idempotent, double-draw safe, rolls itself back on failure |
| `lib/draw-rules.ts` | `drawDecision()` — the pure rules for when a draw may run (full? already drawn? knockout?) |
| `lib/groups.ts` | `shufflePlayers()`, `createGroups()`, `generateGroupFixtures()`, `updateStandings()`, `getTopTwo()`, `rankStandings()` |
| `lib/bracket.ts` | `createKnockoutBracket()`, `pairFirstKnockoutRound()`, `getGroupWinners()`, `checkAndResolveMatch()`, round labels and advancement |
| `lib/data.ts` | Server-side loaders for tournaments, groups, standings, fixtures, brackets |
| `lib/validation.ts` | Server-side validation for the registration and result forms |
| `lib/format.ts` | Cedi/date/phone/WhatsApp helpers and match-status badges |

---

## 📋 Running a tournament (admin)

### Step 1 — players register and pay

Nothing to do: each player registers on `/` and pays GH₵10 with MoMo. Their row
in `registrations` starts as `pending` and flips to `paid` once Paystack
confirms the money.

### Step 2 — the groups are drawn automatically

There is nothing to do: **the draw runs by itself the moment the last slot is
paid for.** It is triggered by the payment confirmation (the signed webhook and
the browser callback both go through it) and, as a safety net, by the next
request for the homepage of a tournament that is already full — so a tournament
that filled up before this existed, or one whose draw was interrupted, never
sits waiting for anyone.

The draw is safe to trigger over and over: a duplicate Paystack delivery, the
browser callback arriving beside it, and several people opening the homepage at
once all produce **one** set of groups. A database lock on the tournament status
decides which request does the work, and the unique index on
`groups (tournament_id, group_name)` means a second draw can never create a
second Group A. If a draw fails half-way, everything it wrote is rolled back, so
the next attempt starts clean.

The command below is the **recovery fallback** for the organizer — use it if a
tournament must be drawn early by hand (it may draw from 6 players up), or if an
automatic attempt could not be completed:

```bash
curl -X POST https://YOUR-DOMAIN/api/admin/draw-groups \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"tournament_id":"THE-TOURNAMENT-UUID"}'
```

(An `x-admin-secret: YOUR_ADMIN_SECRET` header works too.)

Either way, the draw itself does this:

1. Takes every **paid** player. The format needs **2 or 4 groups**, so allowed
   sizes are **6–8 players** (2 groups) or **13–16 players** (4 groups).
   9–12 players would draw 3 groups, which the knockout stage cannot bracket
   (it crosses groups in pairs), so those tournaments are refused at
   registration and the draw refuses them too.
2. Shuffles them with Fisher-Yates — a provably fair draw.
3. Splits them into groups of 4: 8 → A & B, 16 → A–D (6–7 players → two groups
   of 3 and 4; 13–15 → four groups with the remainder spread across the first
   groups).
4. Creates the `groups`, `group_members`, `group_matches` (6 fixtures per group
   of 4) and `group_standings` (all zeros) rows.
5. Sets the tournament status to `groups_drawn`.

It refuses to run twice, and it returns `{ success, groups, fixtures_created }`
with phone numbers omitted. To redraw, delete the `groups`, `group_members`,
`group_matches` and `group_standings` rows for that tournament first.

Find the tournament UUID in **Supabase → Table Editor → tournaments → id**.

### Step 3 — players submit group results

Players open `/submit-result` (or the link on the landing page), pick their
fixture, enter both scores and upload a screenshot of the final scoreboard.
The screenshot goes straight to Supabase Storage; the app then:

- **first submission** → saves it, match stays `pending`
- **second submission matches** → match becomes `completed`, the winner is set
  (or `null` for a draw) and the group table is recalculated instantly
- **second submission conflicts** → match becomes `disputed` for you to review
- **same player submitting twice** → "You already submitted this result"

Standings follow the rules exactly: Win = 3, Draw = 1, Loss = 0, sorted by
points → goal difference → goals scored → head-to-head. Anything still tied is
yours to settle with a penalty shootout; set the order directly in Supabase.

### Step 4 — draw the knockout bracket

Once **every** group fixture is completed:

```bash
curl -X POST https://YOUR-DOMAIN/api/admin/draw-knockout \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"tournament_id":"THE-TOURNAMENT-UUID"}'
```

What it does:

1. Refuses to run until every group fixture is `completed`.
2. Ranks each group (points → goal difference → goals scored → head-to-head) and
   takes the top 2.
3. Creates the matchups — **Semifinal 1: Group A 1st vs Group B 2nd**,
   **Semifinal 2: Group B 1st vs Group A 2nd** — plus the Grand Final as an empty
   placeholder, so the whole route to the trophy is visible from day one.
4. Sets the tournament status to `bracket_drawn`.

Re-running is allowed while no knockout match has been completed, so a mistake
can be corrected before anyone plays. After a match is completed the endpoint
refuses to redraw the bracket.

### Step 5 — players submit knockout results

On `/submit-result` the Knockout Match tab now opens by default. Players pick
their match, tap **I Won ✅** or **I Lost ❌** and upload their screenshot. Because
knockout matches can't draw, there are no scores to compare — the two "who won?"
claims are compared instead:

- **both agree** → the match is confirmed, the winner is moved into the next
  round automatically, and winning the Grand Final sets the tournament to
  `completed`
- **they disagree** → the match is `disputed` for you to review
- **one submission** → saved, match stays `pending`, and the claim is kept
  private so it can't be used to argue with the opponent

### Fixing a disputed match

**Group match:** open **Supabase → Table Editor → group_matches**, correct the
scores, set `status` to `completed` and `winner_id` to the winner (leave it empty
for a draw). Then fix the numbers in `group_standings` too, or re-save the match
in the app to recalculate them.

**Knockout match:** open **Supabase → Table Editor → brackets**, set `status` to
`completed` and `winner_id` to the winner. Then copy that player into the next
round's row (`player_a_id` for a semifinal 1/2 winner, `player_b_id` for
semifinal 2) — or just re-trigger the automatic move by setting the match back to
`pending` with the scores/marker fixed and starting the app's standings recalculation.

---

## 🧪 Test checklist

### Module 1 — registration and payment

- [ ] `/` shows the tournament, `0 / 8 registered`, a live countdown and the
      prize pool (GH₵68.00 / 47.60 / 20.40 when all 8 slots are filled)
- [ ] A bad phone number shows the format error; unticked boxes are rejected
- [ ] A valid submission creates a `pending` row in `registrations`
- [ ] The Paystack popup opens for MTN MoMo / Vodafone Cash / AirtelTigo
- [ ] With the popup blocked, the button redirects to hosted Paystack instead
- [ ] Paying (test mode) lands on `/payment/success` and flips the row to `paid`
- [ ] Checking `/payment/verify` while a MoMo prompt is still open → "still
      being confirmed", and the row stays `pending` (never `failed`)
- [ ] Registering the same number twice → "You are already registered"
- [ ] `status = closed` → "Registration is now closed"
- [ ] 8 `paid` rows → "Tournament Full — contact us on WhatsApp"
- [ ] A tournament whose `max_players` is 9–12 (or under 6) shows the
      "size needs fixing" notice and refuses registrations
- [ ] Two payments racing for the last slot: one confirms, the other gets
      "Payment received, but the last slot was just taken. We will refund you"
      and the row stays unpaid (`mark_registration_paid()` enforces the cap)

### Module 2 — group stage

- [ ] With 7 of 8 players paid, `/` shows no groups and the draw has not run
- [ ] Paying as the 8th player draws the groups automatically (no curl) —
      `npm test` covers this rule, and Supabase shows the rows within seconds
- [ ] Reloading `/`, and letting a duplicate Paystack webhook arrive, still
      leaves exactly 2 groups and 12 fixtures
- [ ] A full tournament whose draw was interrupted is drawn by the next visit
      to `/`
- [ ] `POST /api/admin/draw-groups` without the secret → `401` (recovery route)
- [ ] With the secret → `{ success: true, groups: [...], fixtures_created: 12 }`
      for 8 players (2 groups × 6 fixtures)
- [ ] Supabase shows 2 `groups`, 8 `group_members`, 12 `group_matches`,
      8 `group_standings` rows and `status = groups_drawn`
- [ ] `/groups/<tournamentId>` lists Group A and Group B, top 2 in green, and
      every fixture showing 🟡 Pending
- [ ] Submitting a result as player 1 → match stays Pending, your score is shown
- [ ] Submitting the **same** score as player 2 → Completed, winner shown,
      standings update immediately (P/W/D/L/GF/GA/GD/Pts)
- [ ] Submitting a **different** score → 🔴 Disputed
- [ ] Submitting twice from the same number → "You already submitted this result"
- [ ] An unregistered phone number → "Phone number not registered"
- [ ] A 6MB file → "Screenshot must be under 5MB"; a PDF →
      "Please upload a JPG, PNG or WebP screenshot"
- [ ] Leave the page open: standings refresh on their own within 60 seconds
- [ ] DevTools at **375px**: no horizontal page scroll (the table scrolls
      inside its card), buttons ≥48px, body text ≥16px

### Module 3 — knockout stage

- [ ] `POST /api/admin/draw-knockout` before the group stage is finished →
      "The group stage is not finished yet — N fixture(s) still need a result"
- [ ] Without the secret → `401`; with it → Semifinal 1, Semifinal 2 and a
      placeholder Grand Final
- [ ] `brackets` in Supabase has 3 rows: `1/1`, `1/2` (real players) and `2/1`
      (both players null), and the tournament status is `bracket_drawn`
- [ ] `/bracket/<tournamentId>` shows "Semifinals" then "Grand Final 🏆", all
      cards stacked vertically, Grand Final showing "Waiting for the previous
      round"
- [ ] `/submit-result` now opens on the **Knockout Match** tab
- [ ] Submitting "I won" as one player → match stays Pending (claim kept private)
- [ ] The opponent submitting "I lost" → Completed, winner in green, and the
      winner appears in the Grand Final automatically
- [ ] Both players claiming "I won" → 🔴 Disputed
- [ ] Both semifinals decided → the Grand Final shows both finalists
- [ ] Confirming the Grand Final → champion banner appears and the tournament
      status becomes `completed`
- [ ] Submitting twice from the same number → "You already submitted this result"
- [ ] Any duplicate/false claim → the friendly messages in the brief
      ("Phone number not registered", "Screenshot is required as proof")

> The bracket maths has been verified with 33 automated checks (round labels and
> numbering, A1 v B2 / B1 v A2 crossing, nobody meeting their own group, 6 unique
> fixtures per group of four, slot advancement for a whole tournament, champion
> detection, and no phone numbers leaving the server). Ask if you want the test
> scripts committed.

---

## 🚀 Deploying to Vercel

### 1. Push the code

Already done — this repository is on the `arena/01a0ce95-esport` branch. Merge it
into `main` (or point Vercel at the branch) before deploying.

### 2. Import the project

1. [vercel.com](https://vercel.com) → **Add New → Project** → import this repo
2. Framework preset: **Next.js** (detected automatically) — no build settings to change

### 3. Add the environment variables **before** the first deploy

Vercel → Project → **Settings → Environment Variables**. Add every one of these
for Production, Preview and Development:

- [ ] `NEXT_PUBLIC_SUPABASE_URL`
- [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- [ ] `SUPABASE_SERVICE_ROLE_KEY` ← secret, server only
- [ ] `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` ← `pk_test_…` then `pk_live_…`
- [ ] `PAYSTACK_SECRET_KEY` ← secret
- [ ] `NEXT_PUBLIC_TOURNAMENT_ENTRY_FEE=1000`
- [ ] `NEXT_PUBLIC_ORGANIZER_CUT_PERCENT=15`
- [ ] `ADMIN_SECRET` ← long and random (`openssl rand -hex 24`)
- [ ] `NEXT_PUBLIC_WHATSAPP_CONTACT` ← e.g. `233241234567`
- [ ] `NEXT_PUBLIC_WHATSAPP_GROUP_INVITE_URL`
- [ ] `NEXT_PUBLIC_SITE_URL` ← **the real domain**, e.g. `https://your-app.vercel.app`

⚠️ `NEXT_PUBLIC_SITE_URL` matters: it is the Paystack callback target. If it
still points at `localhost`, payments will not return to your confirmation page.

### 4. Supabase checks

- [ ] The schema has been applied — either `setup.sql` pasted into the SQL
      Editor, or the migration deployed by the GitHub integration (all 7 tables exist)
- [ ] The security hardening has been applied —
      `supabase/migrations/20260924000000_security_and_payment_hardening.sql`
      (automatic via the GitHub integration; paste it once for hand-run projects)
- [ ] Row Level Security is enabled on all 7 tables
- [ ] The `result-screenshots` bucket exists (Storage → Buckets)
- [ ] Switch Paystack to live keys when you are ready to take real money

> **Storage, honestly:** the bucket stays public-by-URL and anonymous-upload by
> design (screenshots upload straight from the player's phone, keeping 3 MB
> photos off the API). The upload policy limits files to images under 5 MB with
> the exact path shape the app writes, but a determined actor could still
> upload images into valid-looking paths. Watch Storage usage; if it ever
> becomes a problem, move the upload server-side so only real match players can
> write. Related: a screenshot whose result submission is rejected afterwards
> (e.g. "already submitted") stays in the bucket unused.

### 5. Full tournament dry run (in Paystack test mode)

1. [ ] Register and pay as 8 players → all appear as `paid`
2. [ ] `POST /api/admin/draw-groups` → 2 groups, 12 fixtures
3. [ ] `/groups/<id>` shows both groups with the top 2 in green
4. [ ] Submit all 12 group results (both sides each time) → standings correct
5. [ ] `POST /api/admin/draw-knockout` → Semifinal 1, Semifinal 2, Grand Final
6. [ ] `/bracket/<id>` shows the bracket and hides the winners until confirmed
7. [ ] Submit both semifinals → the final fills in automatically
8. [ ] Submit the final → champion banner + tournament status `completed`

### 6. Mobile + performance

- [ ] Run the whole flow on an Android phone (Chrome)
- [ ] No horizontal scrolling on any page (tables scroll inside their own card)
- [ ] Payment works in the phone's browser (popup *and* the blocked-popup fallback)
- [ ] Screenshot upload works straight from the phone's camera roll
- [ ] Lighthouse mobile audit: **score above 80** (First Load JS is ~92–101 kB;
      run it on the deployed URL, not localhost, for realistic numbers)

---

## 🩺 Troubleshooting

**The page shows plain unstyled HTML (no colours, no layout).**
`next dev` and `next build` write into the same output folder by default, so
running a production build while the dev server is serving a preview deletes the
dev server's JavaScript and CSS — the browser then gets `404` for every asset and
renders raw HTML. Fix it by stopping the dev server, deleting the build folder
and starting again:

```bash
rm -rf .next
npm run dev
```

To verify a production build *without* disturbing a running dev server, send it
to its own folder (already configured in `next.config.mjs`):

```bash
NEXT_DIST_DIR=.next-build npm run build
```

**The landing page says "Setup needed".**
Supabase is not configured yet: paste `setup.sql` into the Supabase SQL editor,
then copy `.env.example` to `.env.local` and fill in the keys, and restart the
dev server.

**"Groups not drawn yet"**
Expected until you call `POST /api/admin/draw-groups` — see the admin section above.

## 🔒 Security notes

- The service-role key is only ever used inside `app/api/**` and server
  components; it never reaches the browser bundle.
- Row Level Security: the public can **read** tournament data and **insert** a
  registration. There are no public update or delete policies at all — match
  results and standings are written with the service role.
- Phone numbers, MoMo numbers and Paystack references never leave the server;
  the draw response and every page only expose names and DLS team names.
- All API errors are mapped to friendly messages; raw database errors are logged
  server-side only.
- The admin endpoint is protected by `ADMIN_SECRET`; with no secret configured it
  refuses every request rather than allowing an open draw.

---

## 🗺️ Where the project stands

All three modules are built:

| Module | Delivered |
| --- | --- |
| 1 | Registration, Paystack payment (popup + redirect fallback), verification, success page, prize pool |
| 2 | Group draw, standings with full tiebreakers, fixtures, group result submission |
| 3 | Knockout bracket, knockout result submission, automatic advancement, deployment checklist |

Deliberately **not** built, per the brief: user logins, an admin dashboard UI,
leaderboards, in-app chat, automated payouts, multi-tournament UI, push
notifications, native apps, referee accounts, anti-cheat, waitlists and a 3rd
place match.

### Small things you may want next

- Commit the automated test scripts (41 group-stage checks + 33 bracket checks)
- A Vercel Cron job to close registration automatically at the deadline
- Organizer email/WhatsApp alert when a match becomes `disputed`
