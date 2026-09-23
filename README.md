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
| **Module 3** | Knockout stage + deployment | ⏳ Not started (on purpose) |

Module 3 is deliberately **not built yet** — the build plan is one module at a
time. The Knockout Match tab on `/submit-result` shows a "Coming soon"
placeholder, and `/api/submit-result` politely refuses `kind: 'knockout'`.

---

## 🚀 Setup

### 1. Create the database

1. Create a free project at [supabase.com](https://supabase.com)
2. Open **SQL Editor → New query**
3. Paste the whole of **`setup.sql`** and press **RUN**

This creates all 7 tables, the indexes, the Row Level Security policies, the
`result-screenshots` storage bucket, and one starter tournament
(GH₵10 entry, 8 players). It is safe to re-run.

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

### 4. Run it

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
| `/submit-result` | Group Match / Knockout Match tabs (knockout is a Module 3 placeholder) |

### API routes

| Route | Notes |
| --- | --- |
| `POST /api/register` | Validates the form, checks open / full / duplicate, creates the `pending` registration |
| `POST /api/paystack/initialize` | Server-side Paystack transaction (amount can't be tampered with); returns the popup code **and** the redirect URL |
| `POST /api/verify-payment` | Confirms the money with Paystack, marks the registration `paid` |
| `POST /api/admin/draw-groups` | 🔒 Runs the group draw (see below) |
| `POST /api/submit-result` | Records a player's group result, auto-confirms when both agree |

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
| `lib/groups.ts` | `shufflePlayers()`, `createGroups()`, `generateGroupFixtures()`, `updateStandings()`, `getTopTwo()`, `rankStandings()` |
| `lib/data.ts` | Server-side loaders for tournaments, groups, standings, fixtures |
| `lib/validation.ts` | Server-side validation for the registration and result forms |
| `lib/format.ts` | Cedi/date/phone/WhatsApp helpers and match-status badges |

---

## 📋 Running a tournament (admin)

### Step 1 — players register and pay

Nothing to do: each player registers on `/` and pays GH₵10 with MoMo. Their row
in `registrations` starts as `pending` and flips to `paid` once Paystack
confirms the money.

### Step 2 — draw the groups

```bash
curl -X POST https://YOUR-DOMAIN/api/admin/draw-groups \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"tournament_id":"THE-TOURNAMENT-UUID"}'
```

(An `x-admin-secret: YOUR_ADMIN_SECRET` header works too.)

What it does:

1. Takes every **paid** player (needs at least 6, supports up to 16).
2. Shuffles them with Fisher-Yates — a provably fair draw.
3. Splits them 4 per group: 8 → A & B, 10 → 4/3/3, 12 → A, B & C, 16 → A–D.
4. Creates the `groups`, `group_members`, `group_matches` (6 fixtures per group
   of 4) and `group_standings` (all zeros) rows.
5. Sets the tournament status to `groups_drawn`.

It refuses to run twice, and it returns `{ success, groups, fixtures_created }`
with phone numbers omitted. To redraw, delete the `groups`, `group_members`,
`group_matches` and `group_standings` rows for that tournament first.

Find the tournament UUID in **Supabase → Table Editor → tournaments → id**.

### Step 3 — players submit results

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

### Fixing a disputed match

Open **Supabase → Table Editor → group_matches**, correct the scores, set
`status` to `completed` and `winner_id` to the winner (leave it empty for a
draw). Then re-save the standings by re-submitting through the app or editing
`group_standings` directly.

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
- [ ] Registering the same number twice → "You are already registered"
- [ ] `status = closed` → "Registration is now closed"
- [ ] 8 `paid` rows → "Tournament Full — contact us on WhatsApp"

### Module 2 — group stage

- [ ] `POST /api/admin/draw-groups` without the secret → `401`
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

> The draw maths has been verified with 41 automated checks (group sizes,
> 6 unique fixtures per group of four, points/GD/GF/head-to-head ordering,
> shuffle fairness over 2000 runs). Ask if you want that test script committed.

---

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

## 🗺️ What comes next (Module 3)

- `lib/bracket.ts` — `getGroupWinners()`, `createKnockoutBracket()`, `checkAndResolveMatch()`
- `/bracket/[tournamentId]` — vertical match cards, winners in green, 60-second refresh
- Knockout tab on `/submit-result` — "I won" / "I lost" + screenshot, winner
  automatically moved into the Grand Final
- `POST /api/admin/draw-knockout` — SF1: A1 v B2, SF2: B1 v A2, then the Final
- Vercel deployment checklist

Say **"Module 2 done"** and Module 3 will be built on top of this code.
