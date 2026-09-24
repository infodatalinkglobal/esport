# 🚀 Go-Live Checklist — DLS Tournament GH

Everything needed to take the platform from this repo to taking real GH₵ MoMo
entry fees. Do the steps **in order**. The README keeps the deep reference;
this file is the shortest correct path.

---

## 0. Prerequisites

- [ ] GitHub repo (this one) with `main` up to date (merge PR #7 first)
- [ ] Supabase account + project created
- [ ] Paystack account (Ghana) — business details submitted so **live keys** are enabled
- [ ] Vercel account (sign in with GitHub)

## 1. Database (Supabase)

1. Open your project → **SQL Editor → New query**
2. Paste the whole of `setup.sql` → **RUN** (creates 7 tables, RLS, the
   `mark_registration_paid()` function, the storage bucket, one starter tournament)
3. If you had run an **older** `setup.sql` on this project before, also run
   `supabase/migrations/20260924000000_security_and_payment_hardening.sql` once
   (idempotent — running it on a fresh project is harmless too)
4. Copy three values from **Project Settings → API**:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - anon `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` ⚠️ **secret — server only**

## 2. Paystack

1. **Settings → API Keys & Webhooks** → copy the **test** keys:
   - `pk_test_…` → `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY`
   - `sk_test_…` → `PAYSTACK_SECRET_KEY` ⚠️ **secret — server only**
2. Generate an admin secret on your machine:
   ```bash
   openssl rand -hex 24
   ```
   → `ADMIN_SECRET` (protects the two admin draw endpoints)

## 3. Deploy (Vercel)

1. vercel.com → **Add New → Project** → import this repo
2. Framework preset: Next.js (auto-detected) — no build settings to change
3. **Before the first deploy**, add ALL environment variables
   (Settings → Environment Variables → Production *and* Preview):

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | from step 1 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from step 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from step 1 (secret) |
   | `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` | `pk_test_…` for now |
   | `PAYSTACK_SECRET_KEY` | `sk_test_…` for now |
   | `NEXT_PUBLIC_TOURNAMENT_ENTRY_FEE` | `1000` (= GH₵10 in pesewas) |
   | `NEXT_PUBLIC_ORGANIZER_CUT_PERCENT` | `15` |
   | `ADMIN_SECRET` | from step 2 |
   | `NEXT_PUBLIC_WHATSAPP_CONTACT` | your number, e.g. `233241234567` |
   | `NEXT_PUBLIC_WHATSAPP_GROUP_INVITE_URL` | your players' WhatsApp group invite |
   | `NEXT_PUBLIC_SITE_URL` | **`https://YOUR-PROJECT.vercel.app`** — not localhost! |

4. Deploy. Open the URL — the homepage should show "DLS Champions Cup #1".

> `NEXT_PUBLIC_SITE_URL` is the Paystack callback target. If it's wrong,
> payments never return to the confirmation page.

## 4. Paystack webhook

**Settings → API Keys & Webhooks → Webhook URL**:

```text
https://YOUR-PROJECT.vercel.app/api/paystack/webhook
```

Set it in **test mode** first; set it again in **live mode** when you switch
keys (each mode has its own settings). The endpoint verifies the HMAC-SHA512
signature, then re-verifies the transaction with Paystack — but only if the URL
is reachable, so do not skip this.

## 5. Test-mode dry run (fake money)

Play the whole tournament with Paystack test MoMo:

1. Register + pay as **8 different test players** (test mode approves MoMo
   prompts instantly; each needs a unique phone number)
2. After the 8th payment the **groups draw themselves** — `/` links to
   `/groups/<id>` with 2 groups × 6 fixtures
3. Submit every result **from both players** on `/submit-result`
   (matching submissions confirm; conflicting ones go 🔴 disputed)
4. Draw the knockout bracket:
   ```bash
   curl -X POST https://YOUR-PROJECT.vercel.app/api/admin/draw-knockout \
     -H "x-admin-secret: YOUR_ADMIN_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"tournament_id":"THE-TOURNAMENT-UUID"}'
   ```
5. Submit both semifinals (both players each), then the final → champion banner
   on `/bracket/<id>`, tournament `completed`, and the pair appears on
   `/champions`
6. Check `/my-matches?phone=…` shows each test player their own fixtures

Full checklist: README → "Test checklist".

## 6. Go live (real money)

1. Create your **real tournament** — Supabase → Table Editor → `tournaments`:
   set `title`, `entry_fee` (pesewas), `max_players` (**6–8 or 13–16** —
   other sizes can't be bracketed), `registration_deadline`, `match_deadline`,
   `status = 'open'`. Keep or delete the starter row as you like.
2. Paystack: switch both keys to **live** (`pk_live_…` / `sk_live_…`) in
   Vercel env vars → **redeploy** (env changes need a redeploy)
3. Update the live-mode webhook URL if it differs
4. Make one tiny real payment yourself (e.g. GH₵1 tournament) and confirm:
   popup opens → MoMo prompt → `/payment/success` → row is `paid` in Supabase
5. Announce. Watch the first payments arrive in Paystack → **Transactions**

## 7. Day-to-day operations

| Task | How |
| --- | --- |
| Disputed match | Supabase → Table Editor → `group_matches`/`brackets` → set `status='completed'` + `winner_id` (README → "Fixing a disputed match") |
| Draw didn't run (rare) | `curl POST /api/admin/draw-groups` with the admin secret |
| Redraw bracket before any KO match played | `curl POST /api/admin/draw-knockout` again |
| Refund (tournament full at claim time) | Paystack Dashboard → Transactions → refund; the row stays unpaid automatically |
| Payout prizes | MoMo the winner 70% / runner-up 30% of the prize pot (the figures shown on `/champions`) within 1 hour |
| Something's broken | Vercel → Logs (everything is tagged `[context]`) |

## 8. After launch — don'ts

- **Never** prefix `SUPABASE_SERVICE_ROLE_KEY` or `PAYSTACK_SECRET_KEY` with
  `NEXT_PUBLIC_`
- **Never** set `max_players` to 9–12 (3 groups can't be bracketed)
- **Never** delete the storage bucket or disable RLS
- **Never** mix test and live Paystack keys
