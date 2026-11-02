import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyOAuthState } from '../oauth-state.mjs';

test('OAuth state accepts the matching, unexpired query and cookie values', () => {
  assert.equal(verifyOAuthState('secure-random-state', 'secure-random-state', 5000, 1000), true);
});

test('OAuth state rejects a missing cookie', () => {
  assert.equal(verifyOAuthState('secure-random-state', undefined, 5000, 1000), false);
});

test('OAuth state rejects an incorrect cookie and an expired attempt', () => {
  assert.equal(verifyOAuthState('secure-random-state', 'different-state', 5000, 1000), false);
  assert.equal(verifyOAuthState('secure-random-state', 'secure-random-state', 1000, 1001), false);
});
