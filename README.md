# DLS Tournament GH 🎮 — Ghana's #1 DLS Tournament Platform

A mobile-first Dream League Soccer tournament platform for Ghanaian players.
Players register, pay the entry fee with MoMo through Paystack, and are drawn
into groups → knockout.

**Format:** groups of 4 → Semifinals → Grand Final (no 3rd place match).

---

## ✅ Module 1 of 3 is built — Foundation + Payments

This repository currently contains **Module 1 only**. Module 2 (group stage) and
Module 3 (knockout stage) are intentionally **not built yet** — the build plan
says to finish and test one module before starting the next.

### What Module 1 includes

| Piece | File |
| --- | --- |
| Database schema + RLS + storage bucket | `setup.sql` |
| Environment variable guide | `.env.example` |
| Supabase clients (`supabase`, `supabaseAdmin`) | `lib/supabase.ts` |
| Paystack helpers (`initializePayment`, `verifyPayment`, popup + fallback) | `lib/paystack.ts` |
| Prize pool maths (`calculatePrizes`) | `lib/calculations.ts` |
| Shared types (all documented) | `types/index.ts` |
| Live countdown | `components/CountdownTimer.tsx` |
| Prize pool card | `components/PrizeBreakdown.tsx` |
| Registration form | `components/RegistrationForm.tsx` |
| Payment button (popup → automatic redirect fallback) | `components/PaystackButton.tsx` |
| Landing page | `app/page.tsx` |
| Payment verification page | `app/payment/verify/page.tsx` |
| Payment success page | `app/payment/success/page.tsx` |
| Verify payment API | `app/api/verify-payment/route.ts` |

### Three extra API routes (required by Module 1's own rules)

The brief's page list only names `/api/verify-payment`, but Module 1 also
requires that the tournament is checked for "open", "not full" and "not already
registered" **before** payment, and that a `pending` registration is created.
Those checks need the service-role key, so they cannot happen in the browser:

| Route | Why it exists |
| --- | --- |
| `POST /api/register` | Validates the form, checks open/full/duplicate, creates the `pending` registration |
| `POST /api/paystack/initialize` | Creates the Paystack transaction server-side (amount can't be tampered with) and returns the popup code + redirect URL |
| `POST /api/verify-payment` | Confirms the money with Paystack and marks the registration `paid` |

### Payment flow (including the blocked-popup fallback)

```
RegistrationForm → POST /api/register          (creates 'pending' registration)
                 → POST /api/paystack/initialize (server → Paystack, returns access_code + authorization_url)
                 → Paystack popup via access_code   ← primary, stays on our page
                     ↳ if the popup cannot load/closes → redirect to authorization_url (hosted checkout)
                 → /payment/verify?reference=…      (spinner: "Verifying payment…")
                 → POST /api/verify-payment         (server confirms with Paystack, marks 'paid')
                 → /payment/success                 (checkmark, WhatsApp group, share button)
```

A manual "Open the Paystack checkout page" link is always shown as well, so a
popup blocker can never stop someone from paying.

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

Then fill in every value — each variable in `.env.example` says exactly where to
find it. The minimum to get running:

```env
NEXT_PUBLIC_SUPABASE_URL=…
NEXT_PUBLIC_SUPABASE_ANON_KEY=…
SUPABASE_SERVICE_ROLE_KEY=…
NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY=pk_test_…
PAYSTACK_SECRET_KEY=sk_test_…
NEXT_PUBLIC_TOURNAMENT_ENTRY_FEE=1000     # 1000 pesewas = GH₵10
NEXT_PUBLIC_ORGANIZER_CUT_PERCENT=15
ADMIN_SECRET=…                            # used from Module 2 onwards
NEXT_PUBLIC_WHATSAPP_CONTACT=233241234567 # footer + error help links
NEXT_PUBLIC_WHATSAPP_GROUP_INVITE_URL=…   # success page group button
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

⚠️ `SUPABASE_SERVICE_ROLE_KEY` and `PAYSTACK_SECRET_KEY` must **never** be
prefixed with `NEXT_PUBLIC_`, and never committed. `.env.local` is git-ignored.

### 4. Run it

```bash
npm install
npm run dev      # http://localhost:3000
```

Useful scripts: `npm run build` (production build), `npm start` (serve the
build), `npm run typecheck` (TypeScript only).

---

## 🧪 Module 1 test checklist

- [ ] `/` shows the tournament title, entry fee, "0 / 8 registered", a live
      countdown, and the prize pool (GH₵68.00 / 47.60 / 20.40 when 8 slots are full)
- [ ] Submitting the form with a bad phone number shows the format error
- [ ] Submitting without ticking both boxes shows the checkbox error
- [ ] A valid submission creates a `pending` row in **Supabase → registrations**
- [ ] The Paystack popup opens for MTN MoMo / Vodafone Cash / AirtelTigo
- [ ] With the popup blocked (Brave/Ad-block), the button redirects to the
      hosted Paystack page instead
- [ ] After paying with a Paystack **test** payment, `/payment/verify` shows the
      spinner and then lands on `/payment/success`
- [ ] The registration row flips to `paid` in Supabase, with the reference filled in
- [ ] Registering the **same phone number twice** shows "You are already registered"
- [ ] Setting `status` to `closed` in the tournaments table shows
      "Registration is now closed"
- [ ] Setting `max_players = 0`… instead, backfill 8 `paid` rows, then check
      "Tournament Full — contact us on WhatsApp"
- [ ] Browser DevTools → Device toolbar at **375px**: no horizontal scrolling,
      buttons at least 48px tall, body text at least 16px

### Paystack test payments

In test mode use a Paystack test card (e.g. `4084 0840 8408 4081`, any future
expiry, CVV `408`, PIN `0000`, OTP `123456`) or the test MoMo flow shown in the
Paystack dashboard. No real money moves in test mode.

---

## 🔒 Security notes

- The service-role key is only ever used inside `app/api/**` and server
  components; it never reaches the browser bundle.
- Row Level Security: the public can **read** tournament data and **insert** a
  registration. There are no public update or delete policies at all.
- Phone numbers, MoMo numbers and Paystack references are never returned to the
  browser — only player names and team names will be shown publicly (Module 2).
- All API errors are mapped to friendly messages; raw database errors are logged
  server-side only.
- `setup.sql` includes an optional stricter insert policy (commented out) if you
  want to block direct REST inserts into a closed or full tournament.

---

## 🗺️ What comes next

- **Module 2 — Group stage:** `lib/groups.ts`, group tables/fixtures/result
  submission, `/groups/[tournamentId]`, `/submit-result` (group tab),
  `/api/admin/draw-groups`
- **Module 3 — Knockout + deployment:** `lib/bracket.ts`, `/bracket/[tournamentId]`,
  knockout tab, `/api/admin/draw-knockout`, Vercel deployment checklist

Say **"Module 1 done"** and Module 2 will be built on top of this code.
