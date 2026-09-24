import { createHmac } from 'node:crypto';

/**
 * Validate Paystack's x-paystack-signature over the exact, unparsed body.
 * Paystack signs with HMAC-SHA512 using the integration's secret key.
 */
export function isValidPaystackSignature(
  rawBody: string,
  signature: string | null,
  secretKey: string,
): boolean {
  if (!signature || !/^[a-f\d]{128}$/i.test(signature)) return false;

  const expected = createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const supplied = signature.toLowerCase();
  // Both strings have a fixed, validated length. Compare every character rather
  // than returning at the first mismatch to avoid a timing side channel.
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return difference === 0;
}
