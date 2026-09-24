# Admin Dashboard — Module 4 Design

A simple, powerful organizer dashboard at **`/admin`**, protected by the existing
`ADMIN_SECRET`. It replaces every curl/Postman call and every "fix it in the
Supabase dashboard" workaround with a button.

**Design principles**

1. **No new auth system.** The secret is the password. It is typed once per
   session, kept in `sessionStorage`, and sent as the `x-admin-secret` header on
   every API call — exactly the header the existing admin endpoints already
   accept (`isAdminRequest` in `lib/api.ts`, constant-time compared).
2. **No schema changes.** The dashboard reads and writes the existing 7 tables.
   Privileged writes reuse the hardened paths: payments go through the atomic,
   capacity-checked `mark_registration_paid()` RPC, results reuse
   `updateStandings()` / `advanceWinner()`.
3. **The dangerous logic stays pure and tested.** Every "should this button be
   clickable / is this input valid / what are the stats" decision lives in
   `lib/admin-rules.ts` as pure functions with no database — same pattern as
   `lib/draw-rules.ts` and `lib/result-rules.ts`, tested in
   `tests/admin-rules.test.ts`.
4. **Mobile-first like the player site.** Same night-match theme and Tailwind
   component classes, but a wider `max-w-6xl` container so tables breathe on
   desktop.

---

## Pages

| Route | Purpose |
| --- | --- |
| `/admin` | **Overview** — tournament picker, live stats (paid/total, pending payments, revenue, prize breakdown), group + knockout progress, lifecycle action buttons, recent sign-ups |
| `/admin/players` | **Players** — searchable table with contact details, payment badges, one-tap **Mark paid** (manual MoMo), WhatsApp nudge links |
| `/admin/matches` | **Matches** — every group & knockout fixture with scores, screenshots and status filter chips; **set/override a result** to resolve disputes |
| `/admin/tournaments` | **Tournaments** — edit the selected tournament (title, deadlines, max players, status) and create the next one |

A shared client shell (`components/admin/`) provides the login gate, the tab
navigation, the tournament picker and the admin API context.

## API endpoints (all protected by `x-admin-secret`)

| Endpoint | Method | What it does |
| --- | --- | --- |
| `/api/admin/verify` | POST | Confirms the secret (login) |
| `/api/admin/overview` | GET | Tournaments + counts + stats + actions for the overview page |
| `/api/admin/registrations` | GET | Full registration rows for a tournament |
| `/api/admin/registrations/mark-paid` | POST | Manual MoMo confirmation via the capacity-checked RPC |
| `/api/admin/matches` | GET | Group + knockout matches, decorated with names |
| `/api/admin/match-result` | POST | Organizer sets/overrides a result; recalculates standings, advances the bracket |
| `/api/admin/tournaments` | POST / PATCH | Create the next tournament / edit the selected one |
| `/api/admin/reset-group-stage` | POST | Guarded reset so groups can be redrawn (automates the manual Supabase deletion the draw endpoint used to demand) |
| `/api/admin/draw-groups` | POST | *(existing)* draw the groups |
| `/api/admin/draw-knockout` | POST | *(existing)* draw the semifinals + final |

## Guard rails (in `lib/admin-rules.ts`)

- **Status transitions** are an explicit map — e.g. `completed` is a one-way
  door, `open ⇄ closed` is allowed, and `groups_drawn → bracket_drawn` only
  happens through the draw endpoint.
- **Entry fee** is editable only while the tournament is `open` and nobody has
  paid (money math must never mix two fees).
- **max_players** must stay a format-supported size (6–8 or 13–16) and can never
  drop below the number of already-paid players.
- **Results** can only be set on `pending`/`disputed` matches — never re-decided
  on a completed knockout match whose winner already advanced.
- **Reset group stage** is offered only while the status is `groups_drawn`, with
  a confirmation that states how many results will be destroyed.

## File map

```
lib/admin-rules.ts                  pure decisions + input validation (tested)
lib/admin-client.ts                 browser: secret storage + fetch wrapper
lib/admin-data.ts                   server: aggregated loaders for the dashboard
app/admin/layout.tsx                shell (server) + login gate + tabs (client)
app/admin/page.tsx                  Overview
app/admin/players/page.tsx          Players
app/admin/matches/page.tsx          Matches
app/admin/tournaments/page.tsx      Tournament settings + create
components/admin/AdminGate.tsx      auth gate, nav, tournament picker
components/admin/admin-context.tsx  React context: secret + selected tournament
components/admin/ui.tsx             StatCard, Badge, ConfirmButton, Table shells
app/api/admin/…                     the new routes above
tests/admin-rules.test.ts           the pure-logic tests
```
