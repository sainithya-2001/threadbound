import test from 'node:test';
import assert from 'node:assert/strict';
import { InvalidRefreshTokenError, refreshOAuthTokens, refreshSessionIfNeeded, tokenNeedsRefresh } from '../oauth-refresh.mjs';

const session = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1000, user: { id: '1' } };

test('refreshes expired access tokens and persists rotated refresh tokens', async () => {
  let persisted;
  const outcome = await refreshSessionIfNeeded(session, {
    now: 2000,
    refresh: async token => { assert.equal(token, 'old-refresh'); return { accessToken: 'new-access', refreshToken: 'rotated-refresh', expiresAt: 99_000 }; },
    persist: async next => { persisted = next; },
    clear: async () => assert.fail('must not clear a successful session')
  });
  assert.equal(outcome.refreshed, true);
  assert.equal(outcome.session.accessToken, 'new-access');
  assert.equal(outcome.session.refreshToken, 'rotated-refresh');
  assert.deepEqual(persisted, outcome.session);
});

test('leaves non-expiring tokens untouched until the refresh margin', async () => {
  const fresh = { ...session, expiresAt: 100_000 };
  assert.equal(tokenNeedsRefresh(fresh, 0, 5_000), false);
  const outcome = await refreshSessionIfNeeded(fresh, { now: 0, marginMs: 5_000, refresh: async () => assert.fail(), persist: async () => assert.fail(), clear: async () => assert.fail() });
  assert.equal(outcome.refreshed, false);
  assert.equal(outcome.session, fresh);
});

test('rejected refresh token clears the stored session and requests reauthorization', async () => {
  let cleared = false;
  const outcome = await refreshSessionIfNeeded(session, {
    now: 2000,
    refresh: async () => { throw new InvalidRefreshTokenError(); },
    persist: async () => assert.fail('must not persist a rejected token'),
    clear: async () => { cleared = true; }
  });
  assert.equal(cleared, true);
  assert.equal(outcome.session, null);
  assert.equal(outcome.reauthorizationRequired, true);
});

test('Twitch token refresh sends server credentials and accepts a successful rotated pair', async () => {
  let request;
  const tokens = await refreshOAuthTokens({ clientId: 'client', clientSecret: 'private', refreshToken: 'refresh', now: () => 5_000, fetchImpl: async (url, init) => {
    request = { url, body: new URLSearchParams(init.body) };
    return { ok: true, status: 200, json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }) };
  } });
  assert.equal(request.url, 'https://id.twitch.tv/oauth2/token');
  assert.equal(request.body.get('client_secret'), 'private');
  assert.deepEqual(tokens, { accessToken: 'a2', refreshToken: 'r2', expiresAt: 3_605_000 });
});

test('Twitch rejects invalid refresh credentials as a reauthorization case', async () => {
  await assert.rejects(refreshOAuthTokens({ clientId: 'client', clientSecret: 'private', refreshToken: 'revoked', fetchImpl: async () => ({ ok: false, status: 400 }) }), InvalidRefreshTokenError);
});

test('temporary Twitch refresh failures retain a recoverable stored session', async () => {
  let cleared = false;
  await assert.rejects(refreshSessionIfNeeded(session, {
    now: 2000,
    refresh: async () => { throw new Error('temporary'); },
    persist: async () => assert.fail(),
    clear: async () => { cleared = true; }
  }), /temporary/);
  assert.equal(cleared, false);
});
