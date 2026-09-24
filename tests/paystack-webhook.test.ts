import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { isValidPaystackSignature } from '../lib/paystack-webhook';

const secret = 'sk_test_matching_integration';
const body = JSON.stringify({ event: 'charge.success', data: { reference: 'DLS-123' } });

test('accepts a signature made with the matching Paystack secret', () => {
  const signature = createHmac('sha512', secret).update(body).digest('hex');
  assert.equal(isValidPaystackSignature(body, signature, secret), true);
});

test('rejects changed payloads, wrong keys, and malformed signatures', () => {
  const signature = createHmac('sha512', secret).update(body).digest('hex');
  assert.equal(isValidPaystackSignature(`${body} `, signature, secret), false);
  assert.equal(isValidPaystackSignature(body, signature, 'sk_test_other'), false);
  assert.equal(isValidPaystackSignature(body, null, secret), false);
  assert.equal(isValidPaystackSignature(body, 'not-hex', secret), false);
});
