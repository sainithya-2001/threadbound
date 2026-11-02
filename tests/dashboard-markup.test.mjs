import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');

test('dashboard markup includes every static ID referenced by its frontend controller', () => {
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const selectors = [...app.matchAll(/document\.querySelector\(['"]#([\w-]+)['"]\)/g)].map(match => match[1]);
  const missing = [...new Set(selectors)].filter(id => !htmlIds.has(id));
  assert.deepEqual(missing, [], `Dashboard is missing elements referenced by app.js: ${missing.join(', ')}`);
});

test('dashboard starts with sample-only content clearly identified and separate from live containers', () => {
  assert.match(html, /id="sample-banner"[^>]*aria-label="Sample data notice"/);
  assert.match(html, /class="panel conversation-panel sample-only"/);
  assert.match(html, /class="panel draft-panel sample-only"/);
  assert.match(html, /This example raid is not live/);
  assert.match(html, /id="live-context-panel" hidden/);
  assert.match(html, /id="live-raid-list" class="live-raid-list" hidden/);
});

test('simulation mode labels raids and mocked AI as synthetic rather than live Twitch/OpenAI output', () => {
  assert.match(app, /state\.simulationMode === true/);
  assert.match(app, /SYNTHETIC EVENTS/);
  assert.match(app, /MOCKED OPENAI RESPONSE · TEST ONLY/);
  assert.match(app, /SYNTHETIC TEST EVENT · NOT FROM TWITCH/);
  assert.match(app, /No chat or content is sent to OpenAI/);
});
