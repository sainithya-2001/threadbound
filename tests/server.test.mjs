import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('server exposes dashboard and OBS, and can begin OAuth with only the public client ID', async t => {
  const port = 43000 + (process.pid % 10000);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', APP_BASE_URL: `http://127.0.0.1:${port}`, TWITCH_REDIRECT_URI: `http://127.0.0.1:${port}/auth/twitch/callback`, TWITCH_CLIENT_ID: 'test-client-id', TWITCH_CLIENT_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  t.after(async () => { child.kill(); await once(child, 'exit'); });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  let lastError = '';
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    if (child.exitCode !== null) break;
    try { ready = (await fetch(`${base}/api/twitch/status`)).ok; } catch (error) { lastError = error.message; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(ready, true, `Server did not start. Output: ${logs} Last HTTP error: ${lastError}`);

  const dashboard = await fetch(`${base}/`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Arrival desk/);
  const dashboardWithTrackingQuery = await fetch(`${base}/?utm_source=chatgpt.com`);
  assert.equal(dashboardWithTrackingQuery.status, 200);
  assert.match(await dashboardWithTrackingQuery.text(), /THREADBOUND/);
  const overlay = await fetch(`${base}/overlay.html`);
  assert.equal(overlay.status, 200);
  assert.match(await overlay.text(), /Nothing shows without approval/);
  const overlayWithTrackingQuery = await fetch(`${base}/overlay.html?utm_source=chatgpt.com`);
  assert.equal(overlayWithTrackingQuery.status, 200);
  assert.match(await overlayWithTrackingQuery.text(), /THREADBOUND/);
  assert.equal((await fetch(`${base}/**?utm_source=chatgpt.com`)).status, 404);
  assert.equal((await fetch(`${base}/auth/twitch/callback?utm_source=chatgpt.com`)).status, 400);
  const status = await (await fetch(`${base}/api/twitch/status`)).json();
  assert.equal(typeof status.configured, 'boolean');
  assert.equal(status.connected, false);
  assert.deepEqual(status.raids, []);
  assert.equal(status.chat.status, 'not_connected');
  assert.doesNotMatch(JSON.stringify(status.chat), /message|chatter_user|text/i);
  const oauth = await fetch(`${base}/auth/twitch`, { redirect: 'manual' });
  assert.equal(oauth.status, 302);
  assert.equal(new URL(oauth.headers.get('location')).origin, 'https://id.twitch.tv');
  assert.equal(JSON.stringify(status).includes('test-client-secret'), false);
  const authorize = new URL(oauth.headers.get('location'));
  const cookie = oauth.headers.get('set-cookie').split(';')[0];
  const state = authorize.searchParams.get('state');
  const incompleteCallback = await fetch(`${base}/auth/twitch/callback?code=placeholder&state=${state}`, { headers: { Cookie: cookie } });
  assert.equal(incompleteCallback.status, 503);
  assert.match(await incompleteCallback.text(), /no Twitch Client Secret yet/);
  assert.equal((await fetch(`${base}/missing-route`)).status, 404);
});

test('OAuth start redirects with a one-time state cookie and keeps the secret server-side', async t => {
  const port = 43000 + ((process.pid + 1) % 10000);
  const canonicalOrigin = `http://127.0.0.1:${port}`;
  const tempDir = mkdtempSync(join(tmpdir(), 'threadbound-server-test-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), HOST: '0.0.0.0', APP_BASE_URL: canonicalOrigin, TWITCH_REDIRECT_URI: `${canonicalOrigin}/auth/twitch/callback`, TWITCH_CLIENT_ID: 'test-client-id', TWITCH_CLIENT_SECRET: 'server-only-test-secret', THREADBOUND_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'), THREADBOUND_TOKEN_DB: join(tempDir, 'tokens.sqlite') },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  t.after(async () => { child.kill(); await once(child, 'exit'); rmSync(tempDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  let lastError = '';
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    if (child.exitCode !== null) break;
    try { ready = (await fetch(`${base}/api/twitch/status`)).ok; } catch (error) { lastError = error.message; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(ready, true, `Configured test server should start; ${lastError}`);
  const canonicalize = await fetch(`${canonicalOrigin}/auth/twitch`, { redirect: 'manual' });
  assert.equal(canonicalize.status, 302);
  assert.equal(new URL(canonicalize.headers.get('location')).origin, 'https://id.twitch.tv');
  const response = await fetch(`${canonicalOrigin}/auth/twitch`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const authorizeUrl = new URL(response.headers.get('location'));
  assert.equal(authorizeUrl.origin, 'https://id.twitch.tv');
  assert.equal(authorizeUrl.searchParams.get('client_id'), 'test-client-id');
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), `${canonicalOrigin}/auth/twitch/callback`);
  assert.equal(authorizeUrl.searchParams.get('scope'), 'user:read:chat');
  assert.match(authorizeUrl.searchParams.get('state'), /^[a-f0-9]{64}$/);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
  assert.doesNotMatch(response.headers.get('set-cookie'), /Secure/);
  assert.equal(JSON.stringify(await (await fetch(`${base}/api/twitch/status`)).json()).includes('server-only-test-secret'), false);

  const firstState = authorizeUrl.searchParams.get('state');
  const retry = await fetch(`${canonicalOrigin}/auth/twitch`, { redirect: 'manual' });
  const retryState = new URL(retry.headers.get('location')).searchParams.get('state');
  const missingCookie = await fetch(`${canonicalOrigin}/auth/twitch/callback?code=fake&state=${firstState}`, { redirect: 'manual' });
  assert.equal(missingCookie.status, 400);
  const missingCookieBody = await missingCookie.text();
  assert.match(missingCookieBody, /localhost and 127\.0\.0\.1 have separate cookies/);
  assert.match(missingCookieBody, /Try Twitch connection again/);
  const incorrectCookie = await fetch(`${canonicalOrigin}/auth/twitch/callback?code=fake&state=${retryState}`, { headers: { Cookie: 'rb_oauth=wrong-state' }, redirect: 'manual' });
  assert.equal(incorrectCookie.status, 400);
  assert.match(await incorrectCookie.text(), /security check did not match/);
});
