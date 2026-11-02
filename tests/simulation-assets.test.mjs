import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(new URL('./simulation-server.mjs', import.meta.url));
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const publicAssets = [
  'index.html', 'overlay.html', 'styles.css', 'twitch-status.css',
  'context-intelligence.css', 'app.js', 'overlay.js'
];

async function getUnusedLoopbackPort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end();
  });
}

test('simulation fixture serves only allowlisted assets and safely rejects private, malformed, and traversal paths', { timeout: 20_000 }, async t => {
  const assetRoot = mkdtempSync(join(tmpdir(), 'threadbound-simulation-assets-'));
  const port = await getUnusedLoopbackPort();
  const child = spawn(process.execPath, [fixturePath], {
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH || process.env.Path || '',
      SystemRoot: process.env.SystemRoot || '',
      WINDIR: process.env.WINDIR || '',
      THREADBOUND_SIMULATION_PORT: String(port),
      THREADBOUND_SIMULATION_ASSET_ROOT: assetRoot
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {});
      child.kill();
      await Promise.race([exited, delay(3000)]);
    }
    rmSync(assetRoot, { recursive: true, force: true });
  });

  for (const name of publicAssets) writeFileSync(join(assetRoot, name), `PUBLIC_ASSET:${name}`);
  const privateFiles = [
    '.env', '.env.example', '.git/config', '.hidden', 'server.mjs', 'package.json',
    'tests/simulation-server.mjs', 'tests/secret.test.mjs', 'data/threadbound.sqlite',
    'data/tokens.db', 'backups/threadbound.sqlite.bak', 'private.txt'
  ];
  for (const name of privateFiles) {
    const target = join(assetRoot, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `FAKE_PRIVATE_FIXTURE:${name}`);
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Fixture did not start. ${output}`)), 8000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Fixture exited before listening (${code}). ${output}`)); });
    if (output.includes(`127.0.0.1:${port}`)) { clearTimeout(timeout); resolve(); return; }
    child.stdout.on('data', chunk => {
      if (String(chunk).includes(`127.0.0.1:${port}`)) { clearTimeout(timeout); resolve(); }
    });
  });

  for (const path of ['/', '/index.html', '/overlay.html', '/styles.css', '/twitch-status.css', '/context-intelligence.css', '/app.js', '/overlay.js']) {
    const response = await request(port, path);
    assert.equal(response.status, 200, `${path} should be served`);
    assert.ok(response.body.startsWith('PUBLIC_ASSET:'), `${path} should resolve only to its public fixture asset`);
  }

  const deniedPaths = [
    ...privateFiles.map(path => `/${path}`),
    '/.env%00', '/../.env', '/%2e%2e/.env', '/%2E%2E/.env',
    '/%252e%252e/.env', '/..%2f.env', '/%2e%2e%2f.env', '/%5c..%5c.env',
    '/%', '/%ZZ', '/unknown-asset.bin'
  ];
  for (const path of deniedPaths) {
    const response = await request(port, path);
    assert.equal(response.status, 404, `${path} must be rejected`);
    assert.doesNotMatch(response.body, /FAKE_PRIVATE_FIXTURE|ENOENT|[A-Za-z]:\\/);
    assert.equal(response.body.includes(assetRoot), false, 'response must not reveal filesystem paths');
  }
});
