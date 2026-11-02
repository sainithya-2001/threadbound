import test from 'node:test';
import assert from 'node:assert/strict';
import { assessChatMessageSubscription, buildChatMessageSubscriptionRequest, ChatContextWindows, hasChatReadPermission } from '../chat-context.mjs';

test('production windows default to five minutes before and three minutes after a raid', () => {
  const windows = new ChatContextWindows();
  assert.equal(windows.preWindowMs, 5 * 60_000);
  assert.equal(windows.postWindowMs, 3 * 60_000);
  assert.equal(windows.maxMessages, 160);
  windows.clear();
});

test('captures a bounded pre-raid window, freezes it at a real raid, then separates post-raid chat', () => {
  let now = 10_000;
  const windows = new ChatContextWindows({ preWindowMs: 100, postWindowMs: 80, maxMessages: 2, now: () => now });
  const add = (id, text) => windows.add({ message: { text }, chatter_user_name: `private-${id}`, chatter_user_id: id }, id);
  add('m1', 'oldest'); now += 20;
  add('m2', 'before raid'); now += 10;
  assert.equal(windows.beginRaid('raid-1', now), true);
  assert.deepEqual(windows.snapshot().pre.map(message => message.text), ['oldest', 'before raid']);
  now += 5;
  add('m3', 'after raid');
  const snapshot = windows.snapshot();
  assert.deepEqual(snapshot.pre.map(message => message.text), ['oldest', 'before raid']);
  assert.deepEqual(snapshot.post.map(message => message.text), ['after raid']);
  assert.equal(JSON.stringify(snapshot).includes('private-'), false);
});

test('deduplicates message and raid IDs and ignores empty messages', () => {
  const windows = new ChatContextWindows({ now: () => 1000 });
  assert.equal(windows.add({ message: { text: '' } }, 'empty'), false);
  assert.equal(windows.add({ message: { text: 'hello' } }, 'same'), true);
  assert.equal(windows.add({ message: { text: 'duplicate' } }, 'same'), false);
  assert.equal(windows.beginRaid('raid'), true);
  assert.equal(windows.beginRaid('raid'), false);
  assert.equal(windows.stats().preCount, 1);
});

test('pre and post buffers are capped by message count and expire on their windows', () => {
  let now = 1000;
  const windows = new ChatContextWindows({ preWindowMs: 50, postWindowMs: 30, maxMessages: 2, now: () => now });
  for (let i = 0; i < 3; i++) { windows.add({ message: { text: `pre-${i}` } }, `p${i}`); now++; }
  assert.equal(windows.stats().preCount, 2);
  windows.beginRaid('r1', now);
  for (let i = 0; i < 3; i++) { windows.add({ message: { text: `post-${i}` } }, `q${i}`); now++; }
  assert.equal(windows.snapshot().post.length, 2);
  now += 60;
  assert.equal(windows.snapshot(), null);
  assert.equal(windows.stats().preCount, 0);
});

test('builds and assesses chat subscription against broadcaster and WebSocket session', () => {
  const request = buildChatMessageSubscriptionRequest('broadcaster', 'reader', 'session');
  assert.deepEqual(request, {
    type: 'channel.chat.message', version: '1',
    condition: { broadcaster_user_id: 'broadcaster', user_id: 'reader' },
    transport: { method: 'websocket', session_id: 'session' }
  });
  const subs = [{ type: 'channel.chat.message', version: '1', status: 'enabled', condition: request.condition, transport: request.transport }];
  const verified = assessChatMessageSubscription(subs, 'broadcaster', 'reader', 'session');
  assert.equal(verified.enabled, true);
  assert.equal(assessChatMessageSubscription(subs, 'other', 'reader', 'session').broadcasterMatches, false);
  assert.equal(assessChatMessageSubscription(subs, 'broadcaster', 'reader', 'different').sessionMatches, false);
});

test('missing chat permission prevents chat collection authorization', () => {
  assert.equal(hasChatReadPermission([]), false);
  assert.equal(hasChatReadPermission(['user:read']), false);
  assert.equal(hasChatReadPermission(['user:read:chat']), true);
});
