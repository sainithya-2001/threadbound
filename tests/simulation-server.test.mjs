import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = await readFile(new URL('./simulation-server.mjs', import.meta.url), 'utf8');
const frontend = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const overlay = await readFile(new URL('../overlay.js', import.meta.url), 'utf8');
const productionServer = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const cardStore = await readFile(new URL('../context-cards.mjs', import.meta.url), 'utf8');

test('browser simulation fixture is isolated from .env, SQLite, Twitch, EventSub, and live OpenAI', () => {
  assert.match(fixture, /server\.listen\(PORT, '127\.0\.0\.1'/);
  assert.doesNotMatch(fixture, /process\.loadEnvFile|EncryptedTokenStore|DatabaseSync|connectEventSub|wss:\/\/eventsub/);
  assert.match(fixture, /globalThis\.fetch = async \(\) =>/);
  assert.match(fixture, /External network is disabled in the THREADBOUND simulation fixture/);
  assert.match(fixture, /fetchImpl: async \(url, init\)/);
  assert.match(fixture, /THREADBOUND SIMULATION ONLY/);
});

test('fixture status and UI explicitly label synthetic data and mocked OpenAI output', () => {
  assert.match(fixture, /simulationMode: true/);
  assert.match(fixture, /dataMode: 'simulation'/);
  assert.match(fixture, /sampleData: null/);
  assert.match(cardStore, /Synthetic test fixture/);
  assert.match(frontend, /SIMULATION MODE/);
  assert.match(frontend, /SYNTHETIC TEST EVENT · NOT FROM TWITCH/);
  assert.match(frontend, /MOCKED OPENAI RESPONSE · TEST ONLY/);
  assert.match(overlay, /SYNTHETIC TEST EVENT/);
  assert.match(overlay, /Fixture data only · no Twitch event/);
});

test('fixture exposes only test-scoped controls; approved OBS content still uses the production boundary modules', () => {
  assert.match(fixture, /__simulation__\/chat/);
  assert.match(fixture, /__simulation__\/raid/);
  assert.match(fixture, /__simulation__\/generate/);
  assert.match(fixture, /__simulation__\/reset/);
  assert.match(fixture, /cards\.approvedView\(\)/);
  assert.match(fixture, /cards\.approve\(body\.draftId, body\.text\)/);
  assert.match(fixture, /cards\.dismiss\(body\.draftId\)/);
  assert.match(fixture, /request\.store !== false/);
  assert.match(fixture, /request\.tools\.length !== 0/);
});

test('production demo mode guards OAuth, token storage, EventSub, chat, and OpenAI before use', () => {
  assert.match(productionServer, /const CLIENT_ID = DEMO_MODE \? ''/);
  assert.match(productionServer, /const CLIENT_SECRET = DEMO_MODE \? ''/);
  assert.match(productionServer, /const OPENAI_API_KEY = DEMO_MODE \? ''/);
  assert.match(productionServer, /if \(!DEMO_MODE && CLIENT_ID && CLIENT_SECRET\)/);
  assert.match(productionServer, /if \(DEMO_MODE\) throw new Error\('Twitch OAuth is disabled in demo mode\.'/);
  assert.match(productionServer, /if \(DEMO_MODE\) throw new Error\('Twitch EventSub is disabled in demo mode\.'/);
  assert.match(productionServer, /if \(DEMO_MODE\) return;\s*if \(!twitch\) return;/);
  assert.match(productionServer, /if \(DEMO_MODE\) return;\s*clearTimeout\(tokenRefreshTimer\)/);
  assert.match(productionServer, /if \(DEMO_MODE\) return;\s*clearTimeout\(reconnectTimer\)/);
  assert.match(productionServer, /if \(DEMO_MODE \|\| !tokenStoreReady\) return;/);
  assert.match(productionServer, /if \(!DEMO_MODE && tokenStoreReady\) void restorePersistedSession\(\);/);
});
