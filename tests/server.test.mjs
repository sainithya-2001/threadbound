import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';

function createHttpHarness(environment = {}, assetRoot) {
  const configuredOrigin = environment.APP_BASE_URL || environment.TWITCH_REDIRECT_URI || 'http://localhost:4173';
  const configuredPort = new URL(configuredOrigin).port || '4173';
  const safeEnvironment = {
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || '',
    TEMP: process.env.TEMP || tmpdir(),
    TMP: process.env.TMP || tmpdir(),
    NODE_ENV: 'test',
    THREADBOUND_TEST_NO_LISTEN: 'true',
    PORT: configuredPort,
    DEMO_MODE: 'false',
    TWITCH_CLIENT_ID: '',
    TWITCH_CLIENT_SECRET: '',
    THREADBOUND_ENCRYPTION_KEY: '',
    OPENAI_API_KEY: '',
    ...environment
  };
  const worker = new Worker(new URL('./http-harness-worker.mjs', import.meta.url), { env: safeEnvironment, workerData: { assetRoot } });
  let nextId = 0;
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  worker.on('message', message => {
    if (message.type === 'ready') { readyResolve(message); return; }
    const current = pending.get(message.id);
    if (!current) return;
    pending.delete(message.id);
    if (message.harnessError) current.reject(new Error(message.harnessError));
    else current.resolve({
      status: message.status,
      headers: { get: name => message.headers[name.toLowerCase()] || null },
      text: async () => message.body,
      json: async () => JSON.parse(message.body),
      externalRequestAttempts: message.externalRequestAttempts
    });
  });
  worker.on('error', error => {
    readyReject(error);
    for (const current of pending.values()) current.reject(error);
    pending.clear();
  });
  worker.on('exit', code => {
    if (code !== 0) {
      const error = new Error(`HTTP test worker exited with code ${code}.`);
      readyReject(error);
      for (const current of pending.values()) current.reject(error);
      pending.clear();
    }
  });

  return {
    serverHost: ready.then(message => message.serverHost),
    async fetch(input, options = {}) {
      await ready;
      const target = new URL(input);
      const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
      headers.host ||= target.host;
      const id = ++nextId;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      worker.postMessage({ id, request: {
        method: options.method || 'GET',
        url: `${target.pathname}${target.search}`,
        headers,
        body: options.body || ''
      } });
      return response;
    },
    async close() { await worker.terminate(); }
  };
}

test('static handler serves only allowlisted public assets from an isolated root', async t => {
  const assetRoot = mkdtempSync(join(tmpdir(), 'threadbound-static-root-'));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const publicFiles = ['index.html', 'overlay.html', 'styles.css', 'twitch-status.css', 'context-intelligence.css', 'app.js', 'overlay.js'];
  for (const name of publicFiles) writeFileSync(join(assetRoot, name), `PUBLIC_ASSET:${name}`);
  const privateFiles = [
    '.env', '.git/config', 'server.mjs', 'package.json', 'data/threadbound.sqlite',
    'backup.sqlite', 'tokens.sqlite-wal', '.hidden', 'private.txt'
  ];
  for (const name of privateFiles) {
    const target = join(assetRoot, name);
    const parent = dirname(target);
    if (parent !== assetRoot) mkdirSync(parent, { recursive: true });
    writeFileSync(target, `FAKE_PRIVATE_FIXTURE:${name}`);
  }

  const base = 'http://127.0.0.1:43791';
  const harness = createHttpHarness({ APP_BASE_URL: base }, assetRoot);
  t.after(() => harness.close());
  for (const path of ['/', '/index.html', ...publicFiles.slice(1).map(name => `/${name}`)]) {
    const response = await harness.fetch(`${base}${path}`);
    assert.equal(response.status, 200, `${path} should be public`);
    assert.match(await response.text(), /PUBLIC_ASSET:/);
  }

  const deniedPaths = [
    '/.env', '/%2eenv', '/%2Eenv', '/.%65nv', '/.git/config', '/%2e%67it/config',
    '/server.mjs', '/server%2emjs', '/package.json', '/data/threadbound.sqlite',
    '/backup.sqlite', '/tokens.sqlite-wal', '/.hidden', '/private.txt',
    '/../private.txt', '/%2e%2e/private.txt', '/%252e%252e/private.txt',
    '/%2fserver.mjs', '/%5cserver.mjs', '/%00.env'
  ];
  for (const path of deniedPaths) {
    const response = await harness.fetch(`${base}${path}`);
    assert.equal(response.status, 404, `${path} must not resolve to a file`);
    assert.doesNotMatch(await response.text(), /FAKE_PRIVATE_FIXTURE/);
  }
});

test('server exposes dashboard and OBS, and can begin OAuth with only the public client ID', async t => {
  const port = 43000 + (process.pid % 10000);
  const base = `http://127.0.0.1:${port}`;
  const harness = createHttpHarness({ APP_BASE_URL: base, TWITCH_REDIRECT_URI: `${base}/auth/twitch/callback`, TWITCH_CLIENT_ID: 'test-client-id' });
  assert.equal(await harness.serverHost, '127.0.0.1');
  const fetch = harness.fetch;
  t.after(() => harness.close());

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
  const harness = createHttpHarness({ APP_BASE_URL: canonicalOrigin, TWITCH_REDIRECT_URI: `${canonicalOrigin}/auth/twitch/callback`, TWITCH_CLIENT_ID: 'test-client-id', TWITCH_CLIENT_SECRET: 'server-only-test-secret', THREADBOUND_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'), THREADBOUND_TOKEN_DB: join(tempDir, 'tokens.sqlite') });
  const fetch = harness.fetch;
  t.after(async () => { await harness.close(); rmSync(tempDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
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

test('OAuth initiation stays on port 4174 through canonicalization and Twitch callback construction', async t => {
  const canonicalOrigin = 'http://localhost:4174';
  const aliasOrigin = 'http://127.0.0.1:4174';
  const harness = createHttpHarness({
    HOST: '127.0.0.1', PORT: '4174', APP_BASE_URL: canonicalOrigin,
    TWITCH_REDIRECT_URI: `${canonicalOrigin}/auth/twitch/callback`,
    TWITCH_CLIENT_ID: 'test-client-id'
  });
  t.after(() => harness.close());

  const canonicalized = await harness.fetch(`${aliasOrigin}/auth/twitch`, { redirect: 'manual' });
  assert.equal(canonicalized.status, 302);
  assert.equal(canonicalized.headers.get('location'), `${canonicalOrigin}/auth/twitch`);
  assert.doesNotMatch(canonicalized.headers.get('location'), /:4173/);

  const started = await harness.fetch(`${canonicalOrigin}/auth/twitch`, { redirect: 'manual' });
  assert.equal(started.status, 302);
  const authorization = new URL(started.headers.get('location'));
  assert.equal(authorization.origin, 'https://id.twitch.tv');
  assert.equal(authorization.searchParams.get('redirect_uri'), `${canonicalOrigin}/auth/twitch/callback`);
  assert.match(started.headers.get('set-cookie'), /HttpOnly/);
});

test('startup rejects stale localhost base ports and mismatched Twitch callback origins', async t => {
  const project = new URL('..', import.meta.url);
  for (const configuration of [
    { PORT: '4174', APP_BASE_URL: 'http://localhost:4173', TWITCH_REDIRECT_URI: 'http://localhost:4173/auth/twitch/callback' },
    { PORT: '4174', APP_BASE_URL: 'http://localhost:4174', TWITCH_REDIRECT_URI: 'http://localhost:4173/auth/twitch/callback' }
  ]) {
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: project,
      env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', NODE_ENV: 'test', THREADBOUND_TEST_NO_LISTEN: 'true', ...configuration },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let logs = '';
    child.stderr.on('data', chunk => { logs += chunk.toString(); });
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
    assert.match(logs, /APP_BASE_URL port must match PORT|TWITCH_REDIRECT_URI must match APP_BASE_URL/);
  }
});

test('consent endpoint accepts the host serving the app when it differs from the canonical origin', async t => {
  const port = 43000 + ((process.pid + 2) % 10000);
  const canonicalOrigin = `http://localhost:${port}`;
  const harness = createHttpHarness({ APP_BASE_URL: canonicalOrigin, TWITCH_REDIRECT_URI: `${canonicalOrigin}/auth/twitch/callback` });
  const fetch = harness.fetch;
  t.after(() => harness.close());
  const servedOrigin = `http://127.0.0.1:${port}`;
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
  const harness = createHttpHarness({
    APP_BASE_URL: base,
    TWITCH_REDIRECT_URI: `${base}/auth/twitch/callback`,
    DEMO_MODE: 'true',
    TWITCH_CLIENT_ID: 'demo-test-client-id',
    TWITCH_CLIENT_SECRET: 'demo-test-client-secret',
    OPENAI_API_KEY: 'demo-test-openai-key',
    THREADBOUND_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64url'),
    THREADBOUND_TOKEN_DB: databasePath
  });
  const fetch = harness.fetch;
  t.after(async () => { await harness.close(); rmSync(tempDir, { recursive: true, force: true }); });

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

  const finalStatus = await fetch(`${base}/api/twitch/status`);
  assert.equal(finalStatus.externalRequestAttempts, 0, 'demo request handling must not call external HTTP APIs');
});

test('invalid DEMO_MODE values fail startup instead of falling back to live mode', async () => {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, NODE_ENV: 'test', PORT: String(43000 + ((process.pid + 4) % 10000)), DEMO_MODE: 'sometimes' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let logs = '';
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
  assert.match(logs, /DEMO_MODE must be explicitly true or false/);
});
