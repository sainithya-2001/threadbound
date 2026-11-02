import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

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
  assert.equal(status.context.status, 'idle');
  assert.deepEqual(status.aiConsent, { enabled: false });
  assert.doesNotMatch(JSON.stringify(status), /chatter_user_(id|name)|raw chat|exact source quote/i);
  assert.deepEqual(await (await fetch(`${base}/api/context/approved`)).json(), { approved: false });
  const unconnectedApproval = await fetch(`${base}/api/context/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ draftId: 'unapproved-draft', text: 'This must not reach OBS.' })
  });
  assert.equal(unconnectedApproval.status, 409);
  assert.deepEqual(await (await fetch(`${base}/api/context/approved`)).json(), { approved: false });
  const crossOriginApproval = await fetch(`${base}/api/context/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.invalid' },
    body: JSON.stringify({ draftId: 'unapproved-draft', text: 'This must not reach OBS.' })
  });
  assert.equal(crossOriginApproval.status, 403);
  assert.deepEqual(await (await fetch(`${base}/api/context/approved`)).json(), { approved: false });
  const originlessApproval = await fetch(`${base}/api/context/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId: 'unapproved-draft', text: 'This must not reach OBS.' })
  });
  assert.equal(originlessApproval.status, 403);
  assert.deepEqual(await (await fetch(`${base}/api/context/approved`)).json(), { approved: false });
  const consentOn = await fetch(`${base}/api/context/consent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ enabled: true })
  });
  assert.deepEqual(await consentOn.json(), { enabled: true });
  assert.deepEqual((await (await fetch(`${base}/api/twitch/status`)).json()).aiConsent, { enabled: true });
  const consentOff = await fetch(`${base}/api/context/consent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ enabled: false })
  });
  assert.deepEqual(await consentOff.json(), { enabled: false });
  assert.deepEqual((await (await fetch(`${base}/api/twitch/status`)).json()).aiConsent, { enabled: false });
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

test('consent endpoint accepts the host serving the app when it differs from the canonical origin', async t => {
  const port = 43000 + ((process.pid + 2) % 10000);
  const canonicalOrigin = `http://localhost:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), HOST: '0.0.0.0', APP_BASE_URL: canonicalOrigin, TWITCH_REDIRECT_URI: `${canonicalOrigin}/auth/twitch/callback`, TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', OPENAI_API_KEY: '' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  t.after(async () => { child.kill(); await once(child, 'exit'); });
  const servedOrigin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    if (child.exitCode !== null) break;
    try { ready = (await fetch(`${servedOrigin}/api/twitch/status`)).ok; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(ready, true, 'Alternate-origin consent test server should start.');
  const response = await fetch(`${servedOrigin}/api/context/consent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: servedOrigin }, body: JSON.stringify({ enabled: true })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true });
  const crossOrigin = await fetch(`${servedOrigin}/api/context/consent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.invalid' }, body: JSON.stringify({ enabled: false })
  });
  assert.equal(crossOrigin.status, 403);
});

test('explicit demo mode ignores live credentials and blocks Twitch, chat, AI, and token storage', async t => {
  const port = 43000 + ((process.pid + 3) % 10000);
  const base = `http://127.0.0.1:${port}`;
  const tempDir = mkdtempSync(join(tmpdir(), 'threadbound-demo-test-'));
  const databasePath = join(tempDir, 'must-not-be-opened.sqlite');
  const auditPath = join(tempDir, 'network-attempts.log');
  const denyNetworkPath = fileURLToPath(new URL('./deny-network.cjs', import.meta.url)).replaceAll('\\', '/');
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${denyNetworkPath}`].filter(Boolean).join(' ');
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      THREADBOUND_TEST_NETWORK_AUDIT: auditPath,
      PORT: String(port), HOST: '127.0.0.1', APP_BASE_URL: base,
      TWITCH_REDIRECT_URI: `${base}/auth/twitch/callback`,
      DEMO_MODE: 'true',
      TWITCH_CLIENT_ID: 'demo-test-client-id',
      TWITCH_CLIENT_SECRET: 'demo-test-client-secret',
      OPENAI_API_KEY: 'demo-test-openai-key',
      THREADBOUND_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64url'),
      THREADBOUND_TOKEN_DB: databasePath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  let ready = false;
  let lastError = '';
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    if (child.exitCode !== null) break;
    try { ready = (await fetch(`${base}/api/twitch/status`)).ok; }
    catch (error) { lastError = error.message; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(ready, true, `Demo server did not start. Output: ${logs} Last HTTP error: ${lastError}`);

  const dashboard = await fetch(`${base}/`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /DEMO MODE/);
  const overlay = await fetch(`${base}/overlay.html`);
  assert.equal(overlay.status, 200);
  const overlayScript = await (await fetch(`${base}/overlay.js`)).text();
  assert.match(overlayScript, /DEMO MODE · NOTHING LIVE IS CONNECTED/);
  assert.match(overlayScript, /card\.approved !== true/);

  const status = await (await fetch(`${base}/api/twitch/status`)).json();
  assert.equal(status.demoMode, true);
  assert.equal(status.dataMode, 'sample');
  assert.equal(status.configured, false);
  assert.equal(status.tokenStorageReady, false);
  assert.equal(status.oauthCanStart, false);
  assert.equal(status.connected, false);
  assert.equal(status.eventSub.connected, false);
  assert.equal(status.eventSub.status, 'disabled_demo_mode');
  assert.equal(status.raidSubscription.enabled, false);
  assert.equal(status.raidSubscription.status, 'disabled_demo_mode');
  assert.equal(status.chat.authorized, false);
  assert.equal(status.chat.subscriptionEnabled, false);
  assert.equal(status.chat.collectionActive, false);
  assert.deepEqual(status.chat.window, { preCount: 0, postCount: 0, activeRaidWindow: false, postWindowOpen: false });
  assert.deepEqual(status.aiConsent, { enabled: false, locked: true });
  assert.equal(status.sampleData.source, 'sample');
  assert.match(status.sampleData.label, /NOT FROM TWITCH/);
  assert.deepEqual(status.raids, []);
  assert.equal(status.context.status, 'idle');
  assert.equal(JSON.stringify(status).includes('demo-test-openai-key'), false);
  assert.equal(existsSync(databasePath), false, 'demo startup must not initialize or access the token database');

  const oauthStart = await fetch(`${base}/auth/twitch`);
  assert.equal(oauthStart.status, 404);
  const oauthCallback = await fetch(`${base}/auth/twitch/callback?code=not-used&state=not-used`);
  assert.equal(oauthCallback.status, 404);
  const twitchDisconnect = await fetch(`${base}/api/twitch/disconnect`, {
    method: 'POST', headers: { Origin: base }
  });
  assert.equal(twitchDisconnect.status, 409);

  const enableConsent = await fetch(`${base}/api/context/consent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(enableConsent.status, 409);
  assert.deepEqual(await enableConsent.json(), { enabled: false, locked: true, error: 'AI analysis cannot be enabled in demo mode.' });
  const disableConsent = await fetch(`${base}/api/context/consent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(disableConsent.status, 200);
  assert.deepEqual(await disableConsent.json(), { enabled: false, locked: true });
  assert.deepEqual(await (await fetch(`${base}/api/context/approved`)).json(), { approved: false });

  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(existsSync(auditPath), false, 'demo startup and consent attempts must not call Twitch, EventSub, chat, or OpenAI network APIs');
  assert.doesNotMatch(logs, /Twitch OAuth configured|Twitch confirmed|Conversation draft ready/);
  assert.match(logs, /DEMO_MODE=true; Twitch OAuth, token storage, EventSub, chat, and OpenAI are disabled/);
});

test('invalid DEMO_MODE values fail startup instead of falling back to live mode', async () => {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(43000 + ((process.pid + 4) % 10000)), DEMO_MODE: 'sometimes' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let logs = '';
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
  assert.match(logs, /DEMO_MODE must be explicitly true or false/);
});
