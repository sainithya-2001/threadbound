import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRaidSubscription, buildRaidSubscriptionRequest, getEventSubSessionId } from '../eventsub-utils.mjs';

test('reads the EventSub Welcome session.id field', () => {
  assert.equal(getEventSubSessionId({ session: { id: 'socket-123' } }), 'socket-123');
  assert.equal(getEventSubSessionId({ session: { session_id: 'wrong-field' } }), null);
});

test('builds the Twitch channel.raid websocket request using the Welcome session ID', () => {
  assert.deepEqual(buildRaidSubscriptionRequest('broadcaster-1', 'socket-123'), {
    type: 'channel.raid', version: '1',
    condition: { to_broadcaster_user_id: 'broadcaster-1' },
    transport: { method: 'websocket', session_id: 'socket-123' }
  });
  assert.throws(() => buildRaidSubscriptionRequest('broadcaster-1', undefined), /session ID are required/);
});

test('confirms only an enabled raid subscription for the broadcaster and live session', () => {
  const subscription = {
    type: 'channel.raid', version: '1', status: 'enabled',
    condition: { to_broadcaster_user_id: 'broadcaster-1' },
    transport: { method: 'websocket', session_id: 'socket-1' }
  };
  assert.deepEqual(assessRaidSubscription([subscription], 'broadcaster-1', 'socket-1'), {
    subscription, broadcasterMatches: true, sessionMatches: true, enabled: true
  });
  assert.equal(assessRaidSubscription([subscription], 'another-broadcaster', 'socket-1').enabled, false);
  assert.equal(assessRaidSubscription([subscription], 'broadcaster-1', 'stale-socket').enabled, false);
  assert.equal(assessRaidSubscription([{ ...subscription, status: 'websocket_disconnected' }], 'broadcaster-1', 'socket-1').enabled, false);
});
