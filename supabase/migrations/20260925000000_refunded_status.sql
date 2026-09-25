-- =============================================================================
-- DLS TOURNAMENT PLATFORM — REFUNDED PAYMENT STATUS  (Module 4)
-- =============================================================================
-- Adds 'refunded' to the registrations payment_status check constraint, so the
-- admin dashboard can record money returned to a player (via Paystack's refund
-- API or by hand for MoMo) without abusing 'failed'.
--
-- Why a status and not a delete: the row is the player's payment trail —
-- the Paystack reference on it is what ties a refund to its original
-- transaction. A refunded row simply stops counting towards the tournament's
-- paid slots, which frees the place for the next player.
--
-- SAFE TO RUN TWICE — the constraint is dropped before being recreated.
--
-- ⚠️ setup.sql carries the identical change (see its "KEEPING THEM IN SYNC"
-- note): new setups get it from setup.sql, existing databases from this file.
-- =============================================================================

alter table public.registrations
  drop constraint if exists registrations_payment_status_check;

alter table public.registrations
  add constraint registrations_payment_status_check
  check (payment_status in ('pending', 'paid', 'failed', 'refunded'));
