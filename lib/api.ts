/**
 * Shared helpers for the API routes.
 *
 * Two promises are kept here:
 * 1. Users never see a raw database error (the rules require meaningful
 *    messages instead), and
 * 2. The admin endpoints are always protected by the `x-admin-secret` header.
 */

import { NextResponse } from 'next/server';

/**
 * Standard JSON success response.
 *
 * @param data Payload to return.
 * @param status HTTP status code (default 200).
 */
export function jsonOk<T extends object>(data: T, status = 200) {
  return NextResponse.json({ ...data, success: true }, { status });
}

/**
 * Standard JSON error response with a user-safe message.
 *
 * @param message The message a player will read. Never include SQL text,
 *                column names or stack traces here.
 * @param status HTTP status code (default 400).
 * @param extra Optional extra fields (e.g. a specific error code).
 */
export function jsonError(
  message: string,
  status = 400,
  extra: Record<string, unknown> = {},
) {
  return NextResponse.json(
    { success: false, error: message, ...extra },
    { status },
  );
}

/**
 * Logs a server-side error for the organizer (visible in Vercel logs) while
 * returning a friendly message to the player.
 *
 * @param context Short description of what failed, e.g. 'draw-groups'.
 * @param error The thrown value.
 * @param userMessage The safe message to send back.
 * @param status HTTP status code (default 500).
 */
export function handleServerError(
  context: string,
  error: unknown,
  userMessage = 'Something went wrong on our side. Please try again.',
  status = 500,
) {
  console.error(`[${context}]`, error);
  return jsonError(userMessage, status);
}

/**
 * Checks the `x-admin-secret` header against `ADMIN_SECRET`.
 *
 * The admin endpoints are called by curl/Postman, not by the UI (the MVP has no
 * admin dashboard by design).
 *
 * @param request The incoming request.
 * @returns True when the header matches the configured secret.
 */
export function isAdminRequest(request: Request): boolean {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    // Without a configured secret the endpoint refuses every request, rather
    // than silently allowing anyone to redraw a tournament.
    console.error('[admin] ADMIN_SECRET is not set — admin routes are locked.');
    return false;
  }

  const provided =
    request.headers.get('x-admin-secret') ??
    // Allow "Authorization: Bearer <secret>" as a convenience.
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';

  // Constant-ish comparison; both values are short so timing risk is negligible.
  return provided.length === expected.length && provided === expected;
}

/**
 * Safely parses a JSON request body.
 *
 * @param request The incoming request.
 * @returns The parsed body typed as `T`, or null when the body is not valid JSON.
 */
export async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
