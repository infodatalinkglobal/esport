/**
 * Match screenshot uploads — the ONE place that decides where a screenshot is
 * stored and which content type it is sent with.
 *
 * Why this is its own module
 * --------------------------
 * Screenshots upload straight from the player's phone to the
 * `result-screenshots` bucket with the public anon key, so the database is the
 * only gatekeeper:
 *
 *   - the INSERT policy "Public can upload screenshots" (setup.sql) accepts
 *     only object names of the exact shape built below, and
 *   - the bucket itself accepts only the content types below, up to
 *     MAX_SCREENSHOT_BYTES (its `allowed_mime_types` / `file_size_limit`).
 *
 * If this file and the SQL ever disagree, EVERY upload is refused and no
 * player can report a result. tests/screenshot-upload.test.ts checks the paths
 * built here against the policy regex in every SQL file that defines it, so a
 * mismatch fails CI instead of match day.
 *
 * Browser-safe: pure functions, no imports.
 */

/** The Supabase Storage bucket screenshots live in. */
export const SCREENSHOT_BUCKET = 'result-screenshots';

/** Largest screenshot accepted, in bytes — the bucket's `file_size_limit`. */
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/** Accepted content type → the file extension the object is stored with. */
const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** The content types the bucket accepts — its `allowed_mime_types`. */
export const SCREENSHOT_CONTENT_TYPES: readonly string[] = Object.keys(
  EXTENSION_BY_CONTENT_TYPE,
);

/** A Postgres uuid as text, e.g. 3f2b8c1e-9a4d-4e7f-b2c5-6d8e9f0a1b2c. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The content type to upload a picked file with, or null if it is not one we
 * accept.
 *
 * `image/jpg` is not a registered type, but some Android file pickers report
 * it for ordinary JPEGs; it is treated as `image/jpeg` so the bucket (which
 * lists only the standard types) accepts the upload.
 *
 * @param fileType A File's `type`, e.g. "image/png" (may be empty).
 * @returns "image/jpeg", "image/png" or "image/webp" — or null.
 */
export function screenshotContentType(
  fileType: string | null | undefined,
): string | null {
  const type = (fileType ?? '').trim().toLowerCase();
  const normalized = type === 'image/jpg' ? 'image/jpeg' : type;
  return normalized in EXTENSION_BY_CONTENT_TYPE ? normalized : null;
}

/**
 * The storage object name for a new screenshot:
 *
 *   <tournament uuid>/<match uuid>/<unique>.<jpg|png|webp>
 *
 * The name is RELATIVE TO THE BUCKET: Supabase keeps the bucket in its own
 * column (`storage.objects.bucket_id`), so "result-screenshots/" is never part
 * of it. The extension comes from the content type rather than the file name,
 * because phone file names are unreliable ("IMG_1234", "photo.heic.jpg").
 *
 * @param params.tournamentId The match's tournament (must be a uuid).
 * @param params.matchId The match the result is for (must be a uuid).
 * @param params.contentType The file's type (see screenshotContentType).
 * @param params.unique Distinguishes repeated uploads; defaults to a
 *   timestamp plus random suffix. Only exposed so tests are deterministic.
 * @returns The object name, or null if any part is unusable — the upload
 *   would be refused, so the caller should not attempt it.
 */
export function buildScreenshotPath(params: {
  tournamentId: string | null | undefined;
  matchId: string | null | undefined;
  contentType: string | null | undefined;
  unique?: string;
}): string | null {
  const { tournamentId, matchId } = params;
  if (!tournamentId || !UUID_PATTERN.test(tournamentId)) return null;
  if (!matchId || !UUID_PATTERN.test(matchId)) return null;

  const contentType = screenshotContentType(params.contentType);
  if (!contentType) return null;

  const unique = (
    params.unique ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )
    .toLowerCase()
    .replace(/[^0-9a-z-]/g, '');
  if (!unique) return null;

  return `${tournamentId}/${matchId}/${unique}.${EXTENSION_BY_CONTENT_TYPE[contentType]}`;
}
