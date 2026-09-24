# Senior Code Review — DLS Tournament GH

**Scope:** every file in the repo (7 API routes, 2 server pages + 3 route pages, 11 components, 12 lib modules, `setup.sql` + migration, tests, config).
**Method:** full read-through plus runtime reproduction of suspected logic bugs (`npx tsx` against the real modules).
**Verdict:** the architecture is genuinely sound (server-only secrets, DB-level draw lock, signed webhook, idempotent verification). But there are **2 critical** and **4 high** defects that would corrupt or lose money in a real tournament, plus a tail of medium/low issues.

**Status: FIXED.** Every finding below has been fixed (or explicitly dispositioned — see the Fix Log at the bottom). Existing Supabase projects must run `supabase/migrations/20260924000000_security_and_payment_hardening.sql` once; new setups get everything from `setup.sql`.

Priority order below — **most critical first**. ✅ = confirmed by runtime repro, not just by reading.

---

## 🔴 CRITICAL

### 1. Anyone can self-register as `paid` for free — RLS insert policy is `with check (true)`
**Where:** `setup.sql` §3 (and `supabase/migrations/20260923000000_initial_schema.sql`) — `registrations` policy *"Public can insert registrations"*.

The anon key ships in the browser bundle (`NEXT_PUBLIC_SUPABASE_ANON_KEY`), and the insert policy accepts **any** row with **any** column values:

```sql
create policy "Public can insert registrations"
  on public.registrations for insert with check (true);
```

An attacker (or a "clever" player) can `POST /rest/v1/registrations` with the anon key and `payment_status: 'paid'` — bypassing Paystack entirely. Impact:

- play the paid tournament for free;
- fill the tournament with fake paid players → **the automatic group draw fires** → real players' tournament is corrupted;
- inflate/steal slots in a tournament that is about to sell out.

The "OPTIONAL HARDENING" block in `setup.sql` does **not** fix this — it only checks the tournament is open, still allowing `payment_status='paid'` in the same insert.

**Fix:** `with check (payment_status = 'pending' ...)` (+ open-tournament check), in both `setup.sql` and the migration, with a short "apply this to your live project" SQL note. Server inserts keep working (service role bypasses RLS).

---

### 2. ✅ Tournaments with 9–12 players silently exclude an entire group from the knockout stage
**Where:** `lib/bracket.ts` → `pairFirstKnockoutRound()` / `createKnockoutBracket()`; `lib/groups.ts` → `getGroupCount()`; `lib/draw-rules.ts` (`MIN_PLAYERS = 6`, `MAX_PLAYERS = 16`).

`getGroupCount` produces **3 groups for 9–12 players** (9 → 3,3,3 · 10 → 4,3,3 · 12 → 4,4,4 — confirmed). `pairFirstKnockoutRound` walks groups strictly in pairs `(A,B), (C,D)`, so with 3 groups:

```
12 players → groups: 3 | qualifiers: 6 | knockout pairings: 2
   in the knockout: A1,A2,B1,B2   ← Group C's two qualifiers are silently dropped
```

Two groups' worth of players play the group stage and can never advance. Worse, the draw-knockout endpoint reports success (4 qualifiers ≥ 4), and if a 3-pairing bracket is ever built, `nextRoundSlot({round:1, match_number:3})` → `2/2` — a row that doesn't exist, so `advanceWinner()`'s "safety net" inserts a stray extra match and `findChampionId()` can crown the wrong champion.

**Fix (engineer's recommendation):** refuse formats that produce 3 groups — restrict the draw (and registration) to paid counts of **6–8 (2 groups)** or **13–16 (4 groups)**; validate `max_players` too. Alternative (product decision): support 3 groups properly (best-runner-up qualification), which is a bigger change to the published rules. The README explicitly advertises "10 → 4/3/3", so the docs must change either way.

---

## 🟠 HIGH

### 3. Tournament oversell race — capacity is checked, never enforced
**Where:** `app/api/register/route.ts` (steps 3–5), `lib/paystack.ts` → `verifyPayment()` (no capacity check), `app/api/paystack/initialize/route.ts` (no capacity/status re-check).

The register route does check-then-insert with no lock: with one slot left, two concurrent registrations both pass the `paidCount < max_players` check, both insert, both pay — and `verifyPayment()` marks **both** `paid` without ever re-checking capacity. The webhook path does the same. Result: an oversold tournament (9 paid / 8 slots), which then triggers bug #2 and creates a 3-group mess.

**Fix (layered):**
1. In `verifyPayment()`, after a successful Paystack verify, conditionally update: `update ... set payment_status='paid' where id=... and (select count of paid) < max_players` — or count-then-conditional-update inside a transaction/RPC.
2. Re-check capacity in the initialize route (cheap, closes the common path).
3. (Best) move the "claim the last slot" into a Postgres function/RPC that atomically increments and returns success/failure.

### 4. ✅(by inspection) Concurrent group-result submissions corrupt the match — stuck `pending` forever
**Where:** `app/api/submit-result/route.ts` (group branch, steps 4–7).

Both players finishing their game at the same time is the *normal* case — and both submissions take the "first submission" branch (each read the row before the other's write). Each write sets **both** `player_a_score` and `player_b_score` to its own claim (last write wins) and both set their screenshot. Neither goes through the confirm comparison, so the match stays `pending` with two screenshots and one survivor's scoreline — and both players are now locked out by "You already submitted this result". Only the organizer, hand-editing Supabase, can unstick it.

**Fix:** make the write conditional and re-read: `update ... where id=... and player_X_screenshot is null`, and if 0 rows changed, re-read the stored claim and run the same agree/dispute comparison the second-submitter path uses (or move the whole decision into an RPC so read-decide-write is atomic).

### 5. Premature `failed`: Paystack `ongoing`/`pending` treated as a terminal failure
**Where:** `lib/paystack.ts` → `verifyPayment()` step 4 (`data.status !== 'success'` → mark registration `failed`), amplified by `app/payment/verify/page.tsx` ("Check payment again" re-runs it on a **GET**).

Mobile-money charges sit in `ongoing`/`processing` while the player's MoMo prompt is pending — exactly when players hammer "check again" or refresh. Each check flips the registration to `failed`, which (a) shows the player a scary "payment did not go through — you can try again" message while money is mid-flight (risk of double payment), and (b) frees the phone slot for re-registration until the webhook later repairs it.

**Fix:** only mark `failed` for Paystack statuses that are truly terminal (`failed`; arguably `abandoned`), and leave `ongoing`/`pending` untouched with a "still being confirmed" response. Optionally make the verify page's retry a POST.

### 6. Knockout claim race — near-simultaneous "I won/I lost" submissions can manufacture a false dispute
**Where:** `app/api/submit-result/route.ts` → `submitKnockoutResult()` + `lib/bracket.ts` → `checkAndResolveMatch()`.

If both players submit within the read-write window: both see `!opponentHasSubmitted && !match.winner_id`, both unconditionally write their own claim to `winner_id` (last write wins), then both call `checkAndResolveMatch` — one call compares its own claim against itself (confirm), the other compares a stale claim against the overwritten one (dispute). Outcome depends on interleaving: a match where both said "Kofi won" can end up **disputed**, or confirmed-then-rechecked-as-disputed.

**Fix:** store the claim with a conditional update (`... where winner_id is null`) and let `checkAndResolveMatch()` be the only decision point (it already re-reads); on 0-rows-changed, re-read and fall through to comparison. Same pattern as #4 — an RPC solves both.

---

## 🟡 MEDIUM

### 7. `screenshot_url` is completely unvalidated server-side
**Where:** `lib/validation.ts` → `validateGroupResult()` / `validateKnockoutResult()` (confirmed: a `javascript:`-scheme 3 KB string is accepted).

The URL is described as "proof" but the API accepts any string of any length and scheme. Nothing renders it as a link *today* (screenshots are only viewed via Supabase by the organizer), so this is data integrity + a loaded gun for the future — plus it makes the "evidence" promise meaningless.

**Fix:** require `https://` URL, sane max length (e.g. 500), and ideally verify the host matches the project's Storage public-URL host before accepting.

### 8. Public Storage bucket = free anonymous image hosting
**Where:** `setup.sql` §4 — anyone can upload up to 5 MB images with no result attached; the client also sets `contentType` itself (policy checks the client-chosen mimetype), so crafted requests can store non-image content labelled `image/*`.

**Fix:** keep size/type limits but add per-IP abuse monitoring at least; longer term, upload through the API (server checks the submitter is one of the match's players *before* accepting the upload) instead of direct-from-browser.

### 9. Empty-string scores become `0` at the API
**Where:** `lib/validation.ts` → `toScore()` (confirmed: `toScore('')` → `0`).

The browser form blocks empty inputs, but the API turns `""` into a legitimate `0–0` submission — which will "agree" with another faulty `0–0` and confirm a fake result. `Number('') === 0` is the culprit.

**Fix:** reject `''`/whitespace/non-numeric strings explicitly (`typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')`).

### 10. Prize panel hardcodes the organizer cut
**Where:** `components/PrizeBreakdown.tsx` — label says "Organizer cut (15%)" while `calculatePrizes()` reads `NEXT_PUBLIC_ORGANIZER_CUT_PERCENT`. Change the env to 10 % and the page lies to players.

**Fix:** render `ORGANIZER_CUT_PERCENT` in the label.

### 11. Orphaned screenshots on rejected submissions
**Where:** `components/ResultSubmissionForm.tsx` — uploads to Storage *before* calling the API; every validation failure ("already submitted", "not your match", tournament closed) strands the file in the public bucket forever.

**Fix (cheap):** upload after a lightweight pre-check, or accept the orphans with a lifecycle/cleanup note. (Fixing #8 via server-side upload solves this too.)

### 12. No regression tests for the agree/dispute engine — the most fragile logic in the app
**Where:** `tests/` — 16 checks cover draw rules, fixtures, and webhook signatures only. The two-submission agreement logic (#4/#6), standings ranking, winner advancement, and capacity rules have **zero** coverage, which is exactly why bugs #4 and #6 shipped unnoticed.

**Fix:** pure-function tests for the claim-comparison paths + a fake-Supabase test for submit-result; add a GitHub Actions workflow running `typecheck` + `test` on every PR.

---

## ⚪ LOW

13. **`getRegistrationCounts` fetches every row to count** (`lib/data.ts`) — three `head:true` count queries would do. Trivial at ≤16 players, but it runs on every homepage render *and every 5-second poll* from `HomeAutoRefresh`.
14. **Admin secret comparison is not constant-time** (`lib/api.ts` → `isAdminRequest`) — the code even acknowledges it; `crypto.timingSafeEqual` is one line.
15. **`ensureGroupDraw` in-flight map ignores options** (`lib/draw.ts`) — an admin early-draw can be shadowed by a concurrent automatic attempt (and vice-versa). Edge case; document or key the map by `tournamentId:requireFull`.
16. **Webhook returns 500 for permanently-unverifiable references** (`app/api/paystack/webhook/route.ts`) — Paystack will retry a hopeless delivery for hours. Distinguish "retry-able" (network) from "permanent" (unknown reference) if log noise matters.
17. **No security headers** (`next.config.mjs`) — no CSP/HSTS/X-Frame-Options. Low risk for this app but one `headers()` block away.
18. **Success page leaks player name/team to anyone holding the reference URL** (`app/payment/success/page.tsx`) — reference contains ~6 random chars, so brute-force is impractical; noting for completeness.
19. **`eslint.ignoreDuringBuilds: true`** and no linter installed — dead code and type-adjacent bugs (e.g. the `toScore` coercion) would be caught by `@typescript-eslint`.
20. **Doc nits** — `app/page.tsx` comment points at `lib/paystack.ts` for the draw (it's `lib/draw.ts`); README's test checklist says the bracket route returns `matchups` but the response field is `groups`/`fixtures_created` parity only on draw-groups; draw-knockout returns `matchups` — verify README wording when fixing #2.

---

## Suggested fix order

| Batch | Findings | Why together |
| --- | --- | --- |
| **A — money & access** | #1, #3, #5 | Payments/RLS; schema file + migration + server code |
| **B — tournament integrity** | #2, #4, #6 | Bracket + result confirmation, share the same tests |
| **C — hygiene** | #7–#12 | Validation, labels, storage, tests/CI |
| **D — polish** | #13–#20 | Cheap, low risk |

---

## Fix log (post-review)

| # | Status | How it was fixed |
| --- | --- | --- |
| 1 | ✅ Fixed | `registrations` INSERT policy now forces `payment_status = 'pending'` + open tournament (`setup.sql`, initial migration, and new `20260924000000` migration for live projects) |
| 2 | ✅ Fixed | `isSupportedPlayerCount()` (6–8 / 13–16) enforced in `drawDecision()` (`unsupported_format`), the register route, and a homepage warning card; README updated (user chose "restrict") |
| 3 | ✅ Fixed | `mark_registration_paid()` Postgres function — row-locked, capacity-checked, atomic; called from `verifyPayment()` (with a count+conditional-update fallback for pre-migration databases); initialize route re-checks the cap before taking money |
| 4 | ✅ Fixed | Group submissions now use conditional guarded writes (`... where my screenshot is null and opponent's is null and status='pending'`) with re-read + one retry; claims can no longer overwrite each other |
| 5 | ✅ Fixed | Only terminal Paystack statuses (`failed`/`abandoned`/`reversed`) mark a registration `failed`; `ongoing`/`pending` return "still being confirmed — do not pay twice" |
| 6 | ✅ Fixed | Knockout claims stored via the same guarded-write pattern (no screenshots, no claim, pending); `checkAndResolveMatch()` writes are guarded on `status='pending'` and re-read on miss |
| 7 | ✅ Fixed | `screenshot_url` must be a bounded-length `https://` URL (`isValidScreenshotUrl`), enforced in both validators |
| 8 | ✅ Fixed (pragmatic) | Storage upload policy now requires the app's exact path shape (`result-screenshots/<tournament-uuid>/<match-uuid>/<name>.<ext>`); residual anonymous-upload risk documented in README |
| 9 | ✅ Fixed | `toScore()` no longer coerces `''`/whitespace to 0; blank scores are rejected |
| 10 | ✅ Fixed | Prize panel renders `ORGANIZER_CUT_PERCENT` instead of a hardcoded "15%" |
| 11 | ✅ Accepted | Orphaned uploads on rejected submissions documented (README, Storage note); the real fix (#8's server-side upload) is future work |
| 12 | ✅ Fixed | New tests: `tests/bracket.test.ts`, `tests/validation.test.ts`, `tests/result-rules.test.ts`, format-limit cases in `tests/auto-draw.test.ts` (16 → 41 checks); GitHub Actions CI runs typecheck + tests + build on every push |
| 13 | ✅ Fixed | `getRegistrationCounts()` uses three `head:true` count queries — no rows over the wire |
| 14 | ✅ Fixed | Admin secret compared with `timingSafeEqual` over SHA-256 digests |
| 15 | ✅ Fixed | `ensureGroupDraw()` in-flight map keyed by tournament **and** mode |
| 16 | ✅ Fixed | Webhook returns 500 only for transient failures; permanent ones (unknown reference, amount mismatch, tournament full) are accepted with a loud log so Paystack stops retrying |
| 17 | ✅ Fixed | `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS headers added (CSP deliberately deferred — an untested CSP can break the Paystack popup) |
| 18 | ✅ Accepted | Success-page name/team visible to reference holders — impractical to brute-force, documented |
| 19 | ✅ Won't fix now | Linter intentionally absent (documented in `next.config.mjs`); CI covers typecheck/tests/build |
| 20 | ✅ Fixed | Comment/doc references corrected; README matches the new responses and format rules |

**Verification after fixes:** `npm run typecheck` clean · **41/41 tests pass** · production `npm run build` clean.

Batches A and B are the ones that can cost real money or ruin a live tournament; C hardens, D is cosmetic.
