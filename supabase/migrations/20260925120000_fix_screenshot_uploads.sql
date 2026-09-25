-- =============================================================================
-- 20260925120000 — FIX SCREENSHOT UPLOADS
-- =============================================================================
-- For EVERY database set up before this fix (setup.sql itself carried the
-- bug): the Supabase GitHub integration applies this automatically; hand-run
-- setups paste this whole file into Supabase → SQL Editor → Run. Idempotent —
-- running it on a fresh project is harmless too.
--
-- The bug: the "Public can upload screenshots" policy refused EVERY upload,
-- so no player could submit a result (the form said "use a smaller image",
-- which was never the problem). Two independent mistakes:
--
--   1. Its path pattern required names to start with "result-screenshots/".
--      Storage object names are relative to the bucket (the bucket lives in
--      `bucket_id`), so no name ever starts with that.
--   2. It required `metadata->>'size'` between 1 and 5 MB. Supabase checks the
--      insert policy BEFORE the file arrives, when the metadata has no size
--      yet, so that check failed every time as well.
--
-- The fix keeps the same protections, enforced where they actually work:
--   - the policy still accepts only the exact path shape the app writes
--     (lib/screenshots.ts): <tournament uuid>/<match uuid>/<name>.<jpg|jpeg|
--     png|webp>, so the bucket can't be used as general file storage;
--   - type and size move to the bucket's own settings — JPG, PNG or WebP up
--     to 5 MB — which the storage server enforces on every upload.
--
-- ⚠️ setup.sql (and the older migrations that define this policy) carry the
-- identical statements; tests/screenshot-upload.test.ts keeps them honest.
-- =============================================================================

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
