import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ChatContextWindows } from '../chat-context.mjs';
import { ContextCardStore } from '../context-cards.mjs';
import { generateConversationIntelligence } from '../conversation-intelligence.mjs';
import { buildRaidSubscriptionRequest } from '../eventsub-utils.mjs';
import { parseEventSubEnvelope, processChannelRaidNotification } from '../eventsub-raid-handler.mjs';
import { EventSubWebSocketClient } from '../eventsub-websocket-client.mjs';
import { RaidEventStore } from '../raid-events.mjs';

const cliExecutable = process.env.THREADBOUND_TWITCH_CLI_EXE;
const BROADCASTER_ID = '900000001';
const SOURCE_ID = '900000002';
const PRE = [
  'Chat discusses the no-fast-travel boss route.',
  'They are testing a charm build for the eastern gate.',
  'The route avoids fast travel before the final fight.'
];
const POST = [
  'The no-fast-travel route reached the eastern gate.',
  'The final fight is still ahead.',
  'Quick Focus might help with this boss.'
];

function claim(text, ...evidence) { return { text, evidence }; }
function ref(window, messageIndex) { return { window, messageIndex, quote: (window === 'pre' ? PRE : POST)[messageIndex] }; }
function structuredResponse() {
  const pre = index => ref('pre', index);
  const post = index => ref('post', index);
  return {
    status: 'sufficient',
    preRaidAnalysis: {
      topic: claim('Chat discusses the no-fast-travel boss route.', pre(0)),
      activity: claim('They are testing a charm build for the eastern gate.', pre(1)),
      relevantContext: claim('The route avoids fast travel before the final fight.', pre(2))
    },
    postRaidAnalysis: {
      topic: claim('The no-fast-travel route reached the eastern gate.', post(0)),
      activity: claim('The final fight is still ahead.', post(1))
    },
    comparison: {
      continued: claim('The no-fast-travel route remains active after the raid.', pre(2), post(0)),
      changed: claim('The eastern gate was reached.', pre(1), post(0)),
      newcomersMissed: claim('The route avoids fast travel before the final fight.', pre(2), post(1))
    },
    card: {
      whatsHappening: claim('The final fight is still ahead.', post(1)),
      communityDiscussed: claim('Chat discusses the no-fast-travel boss route.', pre(0)),
      newcomersMissed: claim('The route avoids fast travel before the final fight.', pre(2), post(1)),
      continued: claim('The no-fast-travel route remains active after the raid.', pre(2), post(0)),
      changed: claim('The eastern gate was reached.', pre(1), post(0)),
      participationPrompt: claim('Which route for the final fight?', pre(2))
    }
  };
}

async function unusedLoopbackPort() {
  const preferred = createServer();
  try {
    await new Promise((resolve, reject) => {
      preferred.once('error', reject);
      preferred.listen(8080, '127.0.0.1', resolve);
    });
    await new Promise(resolve => preferred.close(resolve));
    return 8080;
  } catch {
    try { preferred.close(); } catch { /* The port was already occupied. */ }
  }
  for (;;) {
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    if (![4174, 4176, 4177].includes(port)) return port;
  }
}

function sanitizedChildEnvironment(configHome) {
  const pathValue = process.env.PATH || process.env.Path || '';
  return {
    PATH: pathValue,
    Path: pathValue,
    SystemRoot: process.env.SystemRoot || '',
    WINDIR: process.env.WINDIR || '',
    TEMP: process.env.TEMP || tmpdir(),
    TMP: process.env.TMP || process.env.TEMP || tmpdir(),
    APPDATA: configHome,
    LOCALAPPDATA: configHome,
    USERPROFILE: configHome,
    HOME: configHome,
    TWITCH_DISABLE_UPDATE_CHECKS: 'true'
  };
}

function spawnCaptured(executable, args, options = {}) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  return { child, getOutput: () => output };
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function waitForProcessExit(child, timeoutMs = 3_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return Promise.race([once(child, 'exit').catch(() => {}), delay(timeoutMs)]);
}

test('production EventSub WebSocket client processes Twitch CLI mock raid without live Twitch or AI', {
  skip: !cliExecutable ? 'Set THREADBOUND_TWITCH_CLI_EXE to a verified Twitch CLI binary.' : false,
  timeout: 60_000
}, async t => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'threadbound-twitch-cli-eventsub-'));
  const configPath = join(tempDirectory, 'empty-twitch-cli-config.env');
  await writeFile(configPath, '', { flag: 'wx' });
  const port = await unusedLoopbackPort();
  const { child: mockServer, getOutput } = spawnCaptured(cliExecutable, [
    '--config', configPath, 'event', 'websocket', 'start-server', '--ip', '127.0.0.1', '--port', String(port)
  ], { env: sanitizedChildEnvironment(tempDirectory) });
  let client;
  t.after(async () => {
    client?.close();
    if (mockServer.exitCode === null && mockServer.signalCode === null) {
      mockServer.kill();
      await waitForProcessExit(mockServer);
    }
    await rm(tempDirectory, { recursive: true, force: true });
  });

  await waitUntil(() => getOutput().includes(`Started WebSocket server on 127.0.0.1:${port}`), 10_000, `Twitch CLI mock WebSocket server startup (${getOutput().slice(-1_200)})`);

  let now = 10_000;
  const chatWindows = new ChatContextWindows({ now: () => now });
  const raidEvents = new RaidEventStore({ now: () => now });
  const cards = new ContextCardStore();
  for (let index = 0; index < PRE.length; index++) {
    assert.equal(chatWindows.add({ message: { text: PRE[index] }, chatter_user_id: `synthetic-private-${index}` }, `cli-pre-${index}`), true);
    now += 10;
  }

  let welcome;
  const welcomes = [];
  let keepaliveCount = 0;
  let processed;
  let acceptedCount = 0;
  const mockSubscriptions = [];
  const errors = [];
  client = new EventSubWebSocketClient({
    WebSocketCtor: WebSocket,
    subscriptionApi: {
      async onWelcome({ sessionId, payload, resume }) {
        assert.equal(typeof sessionId, 'string');
        assert.equal(payload.session.status, 'connected');
        const raidRequest = resume ? null : buildRaidSubscriptionRequest(BROADCASTER_ID, sessionId);
        mockSubscriptions.push({ sessionId, resume, raidRequest });
        welcomes.push({ sessionId, resume });
        welcome = { sessionId, resume };
      }
    },
    handlers: {
      onKeepalive() { keepaliveCount++; },
      onNotification({ envelope }) {
        if (envelope.payload?.subscription?.type !== 'channel.raid') return;
        processed = envelope;
        const result = processChannelRaidNotification({
          envelope,
          broadcasterId: BROADCASTER_ID,
          raidEvents,
          chatWindows,
          now: () => now,
          onAcceptedRaid(raidId, event, receivedAt) {
            acceptedCount++;
            cards.beginRaid(raidId, {
              sourceChannel: event.from_broadcaster_user_name,
              destinationChannel: event.to_broadcaster_user_name,
              viewerCount: event.viewers,
              receivedAt: new Date(receivedAt).toISOString(),
              synthetic: true
            });
          }
        });
        if (result.accepted) processed = { ...envelope, __testResult: result };
      },
      onError(error) { errors.push(error?.message || 'WebSocket error'); }
    }
  });
  client.connect(`ws://127.0.0.1:${port}/ws`);
  await waitUntil(() => Boolean(welcome), 10_000, 'CLI Welcome and injected mock subscription adapter');
  assert.equal(mockSubscriptions.length, 1);
  assert.equal(mockSubscriptions[0].resume, false);
  assert.deepEqual(mockSubscriptions[0].raidRequest, {
    type: 'channel.raid', version: '1',
    condition: { to_broadcaster_user_id: BROADCASTER_ID },
    transport: { method: 'websocket', session_id: welcome.sessionId }
  });

  // Twitch CLI sends a WebSocket session_keepalive after the welcome when no event arrives.
  await waitUntil(() => keepaliveCount > 0, 15_000, 'CLI session_keepalive delivery');

  const trigger = spawnCaptured(cliExecutable, [
    '--config', configPath, 'event', 'trigger', 'channel.raid',
    '--transport=websocket', `--session=${welcome.sessionId}`,
    `--from-user=${SOURCE_ID}`, `--to-user=${BROADCASTER_ID}`
  ], { env: sanitizedChildEnvironment(tempDirectory) });
  const triggerExit = once(trigger.child, 'exit');
  const [triggerCode] = await Promise.race([
    triggerExit,
    delay(10_000).then(() => { trigger.child.kill(); throw new Error('Twitch CLI raid trigger timed out.'); })
  ]);
  assert.equal(triggerCode, 0, 'Twitch CLI accepted the mock raid trigger.');
  await waitUntil(() => Boolean(processed?.__testResult?.accepted), 10_000, 'production raid processor notification');

  const parsedEvent = processed.payload.event;
  assert.equal(processed.metadata.message_type, 'notification');
  assert.equal(processed.payload.subscription.type, 'channel.raid');
  assert.equal(parsedEvent.to_broadcaster_user_id, BROADCASTER_ID);
  assert.equal(parsedEvent.from_broadcaster_user_id, SOURCE_ID);
  assert.equal(raidEvents.list().length, 1);
  assert.equal(raidEvents.list()[0].viewers, parsedEvent.viewers);
  assert.equal(acceptedCount, 1);
  assert.deepEqual(chatWindows.snapshot().pre.map(message => message.text), PRE, 'production processor froze the pre-raid window');
  assert.equal(cards.dashboardView().raidFacts.synthetic, true, 'mock event facts remain explicitly synthetic');

  const mismatchEnvelope = {
    ...processed,
    metadata: { ...processed.metadata, message_id: 'synthetic-cli-mismatch' },
    payload: { ...processed.payload, event: { ...parsedEvent, to_broadcaster_user_id: '900000099' } }
  };
  const mismatch = processChannelRaidNotification({ envelope: mismatchEnvelope, broadcasterId: BROADCASTER_ID, raidEvents, chatWindows, onAcceptedRaid: () => assert.fail('mismatched destination must not start a raid') });
  assert.equal(mismatch.reason, 'destination_mismatch');
  const duplicate = processChannelRaidNotification({ envelope: processed, broadcasterId: BROADCASTER_ID, raidEvents, chatWindows, onAcceptedRaid: () => assert.fail('duplicate notification must not start a second raid') });
  assert.equal(duplicate.reason, 'duplicate_event');
  assert.equal(acceptedCount, 1);

  for (let index = 0; index < POST.length; index++) {
    now += 10;
    assert.equal(chatWindows.add({ message: { text: POST[index] }, chatter_user_name: `synthetic-viewer-${index}` }, `cli-post-${index}`), true);
  }
  const snapshot = chatWindows.snapshot();
  assert.deepEqual(snapshot.pre.map(message => message.text), PRE);
  assert.deepEqual(snapshot.post.map(message => message.text), POST);

  let mockOpenAICalls = 0;
  const draft = await generateConversationIntelligence({
    preMessages: snapshot.pre.map((message, messageIndex) => ({ messageIndex, text: message.text })),
    postMessages: snapshot.post.map((message, messageIndex) => ({ messageIndex, text: message.text })),
    apiKey: 'synthetic-only-test-key',
    consentEnabled: true,
    fetchImpl: async (_url, init) => {
      mockOpenAICalls++;
      const request = JSON.parse(init.body);
      assert.equal(request.store, false);
      assert.deepEqual(request.tools, []);
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(structuredResponse()) }) };
    }
  });
  assert.equal(draft.status, 'sufficient');
  assert.ok(cards.createDraft(processed.metadata.message_id, draft));
  assert.equal(mockOpenAICalls, 1);
  assert.equal(cards.dashboardView().status, 'draft');
  assert.equal(cards.dashboardView().draft.approved, false);
  assert.deepEqual(cards.approvedView(), { approved: false });

  if (port === 8080) {
    const reconnectCommand = spawnCaptured(cliExecutable, [
      '--config', configPath, 'event', 'websocket', 'reconnect'
    ], { env: sanitizedChildEnvironment(tempDirectory) });
    const [reconnectCode] = await Promise.race([
      once(reconnectCommand.child, 'exit'),
      delay(10_000).then(() => { reconnectCommand.child.kill(); throw new Error('Twitch CLI reconnect command timed out.'); })
    ]);
    assert.equal(reconnectCode, 0, 'Twitch CLI accepted the mock reconnect command.');
    await waitUntil(() => welcomes.length >= 2, 10_000, 'production client reconnect and resumed Welcome');
    assert.equal(welcomes[1].resume, true);
    assert.ok(welcomes[1].sessionId);
    assert.equal(mockSubscriptions.length, 2, 'the injected subscription adapter handled both initial and resumed Welcome messages');
    assert.equal(mockSubscriptions[1].raidRequest, null, 'resume verifies existing subscriptions instead of creating duplicates');
  }

  assert.deepEqual(errors, []);
});
