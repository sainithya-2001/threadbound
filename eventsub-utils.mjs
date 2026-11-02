export function getEventSubSessionId(payload) {
  return typeof payload?.session?.id === 'string' && payload.session.id.length > 0
    ? payload.session.id
    : null;
}

export function buildRaidSubscriptionRequest(broadcasterId, sessionId) {
  if (!broadcasterId || !sessionId) throw new Error('Broadcaster ID and EventSub session ID are required.');
  return {
    type: 'channel.raid',
    version: '1',
    condition: { to_broadcaster_user_id: broadcasterId },
    transport: { method: 'websocket', session_id: sessionId }
  };
}

export function assessRaidSubscription(subscriptions, broadcasterId, sessionId) {
  const candidates = subscriptions.filter(item =>
    item.type === 'channel.raid' &&
    item.version === '1' &&
    item.condition?.to_broadcaster_user_id === broadcasterId
  );
  const subscription = candidates.find(item => item.transport?.session_id === sessionId) || candidates[0] || null;
  const broadcasterMatches = Boolean(subscription);
  const sessionMatches = Boolean(subscription && sessionId && subscription.transport?.session_id === sessionId);
  const enabled = Boolean(subscription && subscription.status === 'enabled' && sessionMatches);
  return { subscription, broadcasterMatches, sessionMatches, enabled };
}
