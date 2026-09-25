/**
 * POST /api/admin/verify   (MODULE 4)
 *
 * The dashboard's login check. The organizer types the ADMIN_SECRET into
 * /admin, the browser sends it here as the `x-admin-secret` header, and this
 * endpoint answers 200 when it matches — the same constant-time comparison
 * every other admin endpoint uses (`isAdminRequest` in lib/api.ts).
 *
 * The response carries no data on purpose: proving the secret is right is all
 * this route ever does.
 *
 * Response: { success: true }
 */

import { handleServerError, isAdminRequest, jsonError, jsonOk } from '@/lib/api';

/** Always run on the server, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Checks the organizer's secret.
 *
 * @param request The incoming request (empty body; the secret is the header).
 * @returns 200 with `{ success: true }`, or 401.
 */
export async function POST(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      // The same message a wrong password gets, so the login form can show it.
      return jsonError('That admin secret is not correct.', 401);
    }
    return jsonOk({});
  } catch (error) {
    return handleServerError('admin-verify', error, 'Could not check the secret. Try again.');
  }
}
