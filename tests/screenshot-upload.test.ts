/**
 * Screenshot uploads: the app and the storage policy must agree.
 *
 * Players upload their scoreboard screenshot straight from the phone to the
 * `result-screenshots` bucket, and the only gatekeeper is SQL: the insert
 * policy "Public can upload screenshots" plus the bucket's own type and size
 * settings. An earlier policy demanded names starting with
 * "result-screenshots/" (names are relative to the bucket, so none ever do)
 * and a metadata size Supabase does not have yet when it checks the policy.
 * EVERY upload was refused — nobody could submit a result — while every
 * TypeScript test stayed green, because nothing compared the two sides.
 *
 * These tests read the policy out of EVERY SQL file that defines it (setup.sql
 * and the migrations, any of which may be run by hand) and check the paths
 * lib/screenshots.ts builds against it. The pattern is evaluated as a
 * case-insensitive JavaScript RegExp, like Postgres' `~*`: for the subset it
 * uses (anchors, character classes, counts, alternation) the two agree.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildScreenshotPath,
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_BUCKET,
  SCREENSHOT_CONTENT_TYPES,
  screenshotContentType,
} from '../lib/screenshots';

const ROOT = path.resolve(__dirname, '..');
const FIX_MIGRATION = path.join(
  'supabase',
  'migrations',
  '20260925120000_fix_screenshot_uploads.sql',
);

const TOURNAMENT = '3f2b8c1e-9a4d-4e7f-b2c5-6d8e9f0a1b2c';
const MATCH = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/** One definition of the upload policy, as found in a SQL file. */
interface UploadPolicy {
  /** Repo-relative path of the SQL file. */
  file: string;
  /** The body of its `with check ( … )`. */
  check: string;
  /** Its `name ~* '…'` pattern. */
  namePattern: RegExp;
}

/** Every SQL file a database can be built or patched from. */
function sqlFiles(): string[] {
  const migrations = readdirSync(path.join(ROOT, 'supabase', 'migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => path.join('supabase', 'migrations', file));
  return ['setup.sql', ...migrations];
}

/** The "Public can upload screenshots" definitions in one SQL file. */
function uploadPolicies(file: string): UploadPolicy[] {
  const sql = readFileSync(path.join(ROOT, file), 'utf8');
  const definition =
    /create policy "Public can upload screenshots"[\s\S]*?with check \(([\s\S]*?)\n\s*\);/gi;

  return [...sql.matchAll(definition)].map((found) => {
    const check = found[1];
    const name = /name ~\* '((?:[^']|'')*)'/.exec(check);
    assert.ok(name, `${file}: the upload policy has no name ~* '…' path check`);
    return {
      file,
      check,
      namePattern: new RegExp(name[1].replace(/''/g, "'"), 'i'),
    };
  });
}

const POLICIES = sqlFiles().flatMap(uploadPolicies);
const POLICY_FILES = [...new Set(POLICIES.map((policy) => policy.file))];

test('finds the upload policy in setup.sql and in the fix migration', () => {
  // Guards against the parsing silently finding nothing (and every test
  // below passing vacuously).
  assert.ok(POLICY_FILES.includes('setup.sql'), 'setup.sql defines no upload policy');
  assert.ok(POLICY_FILES.includes(FIX_MIGRATION), `${FIX_MIGRATION} defines no upload policy`);
});

test('every policy accepts every screenshot the app uploads', () => {
  // image/jpg is what some Android pickers report for an ordinary JPEG.
  for (const fileType of ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']) {
    // The real default name: timestamp plus random suffix.
    const name = buildScreenshotPath({
      tournamentId: TOURNAMENT,
      matchId: MATCH,
      contentType: fileType,
    });
    assert.ok(name, `no path built for ${fileType}`);

    for (const policy of POLICIES) {
      assert.match(
        name,
        policy.namePattern,
        `${policy.file} refuses the app's ${fileType} upload "${name}"`,
      );
    }
  }
});

test('every policy still refuses anything that is not a match screenshot', () => {
  const refused = [
    `${SCREENSHOT_BUCKET}/${TOURNAMENT}/${MATCH}/1727222400000-abc123.jpg`, // bucket name inside the name
    `unknown/${MATCH}/1727222400000-abc123.jpg`, // the old form's fallback when the tournament was missing
    `${TOURNAMENT}/1727222400000-abc123.jpg`, // no match folder
    `${TOURNAMENT}/${MATCH}/nested/1727222400000-abc123.jpg`,
    `${TOURNAMENT}/${MATCH}/../1727222400000-abc123.jpg`,
    `${TOURNAMENT}/${MATCH}/1727222400000-abc123.exe`,
    `${TOURNAMENT}/${MATCH}/1727222400000-abc123.jpg.html`,
    `${TOURNAMENT}/${MATCH}/1727222400000-abc123.svg`,
  ];

  for (const policy of POLICIES) {
    for (const name of refused) {
      assert.doesNotMatch(name, policy.namePattern, `${policy.file} accepts "${name}"`);
    }
  }
});

test('no policy depends on file metadata', () => {
  // Supabase evaluates the insert policy BEFORE the upload body arrives: the
  // metadata has no size then, so a metadata->>'size' check refuses every
  // upload. Type and size belong in the bucket settings (next test).
  for (const policy of POLICIES) {
    assert.doesNotMatch(
      policy.check,
      /metadata/i,
      `${policy.file} checks metadata in the upload policy`,
    );
  }
});

test('the bucket enforces the same type and size limits as the form', () => {
  // Every file that (re)defines the policy must also apply the bucket limits,
  // or running it alone would leave uploads unlimited.
  for (const file of POLICY_FILES) {
    const sql = readFileSync(path.join(ROOT, file), 'utf8');
    const limits =
      /update storage\.buckets\s+set file_size_limit = (\d+),\s+allowed_mime_types = array\[([^\]]*)\]\s+where id = 'result-screenshots';/i.exec(
        sql,
      );
    assert.ok(limits, `${file} defines the upload policy but does not set the bucket limits`);

    assert.equal(Number(limits[1]), MAX_SCREENSHOT_BYTES, `${file}: file_size_limit`);
    const types = limits[2]
      .split(',')
      .map((type) => type.trim().replace(/^'|'$/g, ''))
      .sort();
    assert.deepEqual(types, [...SCREENSHOT_CONTENT_TYPES].sort(), `${file}: allowed_mime_types`);
  }
});

test('object names are relative to the bucket, with the extension from the type', () => {
  // A phone file name says nothing reliable ("IMG-20260925-WA0001", no
  // extension), so the extension comes from the content type.
  assert.equal(
    buildScreenshotPath({
      tournamentId: TOURNAMENT,
      matchId: MATCH,
      contentType: 'image/png',
      unique: '1727222400000-abc123',
    }),
    `${TOURNAMENT}/${MATCH}/1727222400000-abc123.png`,
  );
  assert.equal(
    buildScreenshotPath({
      tournamentId: TOURNAMENT,
      matchId: MATCH,
      contentType: 'image/jpg',
      unique: '1727222400000-abc123',
    }),
    `${TOURNAMENT}/${MATCH}/1727222400000-abc123.jpg`,
  );
});

test('no path is built for an upload the bucket would refuse anyway', () => {
  const base = { tournamentId: TOURNAMENT, matchId: MATCH, contentType: 'image/png' };
  assert.equal(buildScreenshotPath({ ...base, tournamentId: null }), null);
  assert.equal(buildScreenshotPath({ ...base, tournamentId: 'unknown' }), null);
  assert.equal(buildScreenshotPath({ ...base, matchId: '' }), null);
  assert.equal(buildScreenshotPath({ ...base, contentType: 'image/heic' }), null);
});

test('content types: "image/jpg" becomes image/jpeg, non-images are refused', () => {
  assert.equal(screenshotContentType('image/jpg'), 'image/jpeg');
  assert.equal(screenshotContentType('IMAGE/PNG'), 'image/png');
  assert.equal(screenshotContentType('image/webp'), 'image/webp');
  for (const type of ['', null, undefined, 'image/heic', 'image/gif', 'image/svg+xml', 'application/pdf', 'text/html']) {
    assert.equal(screenshotContentType(type), null, String(type));
  }
});
