import { randomBytes } from 'node:crypto';

/** Parse one EventSub WebSocket text frame. Invalid or non-JSON frames are ignored. */
export function parseEventSubEnvelope(data) {
  try {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    const envelope = JSON.parse(text);
    return envelope && typeof envelope === 'object' && !Array.isArray(envelope) ? envelope : null;
  } catch {
    return null;
  }
}

/**
 * Process a channel.raid notification for the currently authenticated destination.
 * This is shared by the production WebSocket listener and isolated tests.
 */
export function processChannelRaidNotification({
  envelope,
  broadcasterId,
  raidEvents,
  chatWindows,
  onAcceptedRaid = () => {},
  now = () => Date.now(),
  makeFallbackEventId = () => randomBytes(12).toString('hex')
} = {}) {
  const metadata = envelope?.metadata;
  const payload = envelope?.payload;
  if (metadata?.message_type !== 'notification' || payload?.subscription?.type !== 'channel.raid') {
    return { handled: false, accepted: false, reason: 'not_channel_raid' };
  }

  const event = payload.event;
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      typeof event.from_broadcaster_user_id !== 'string' ||
      typeof event.to_broadcaster_user_id !== 'string' ||
      event.from_broadcaster_user_id === event.to_broadcaster_user_id ||
      !Number.isInteger(event.viewers) || event.viewers < 0) {
    return { handled: true, accepted: false, reason: 'invalid_raid_event' };
  }
  if (typeof broadcasterId !== 'string' || event.to_broadcaster_user_id !== broadcasterId) {
    return { handled: true, accepted: false, reason: 'destination_mismatch' };
  }

  const eventId = typeof metadata.message_id === 'string' && metadata.message_id
    ? metadata.message_id
    : makeFallbackEventId();
  const receivedAt = now();
  if (!raidEvents.add(event, eventId)) return { handled: true, accepted: false, reason: 'duplicate_event' };
  if (!chatWindows.beginRaid(eventId, receivedAt)) return { handled: true, accepted: false, reason: 'duplicate_raid' };

  onAcceptedRaid(eventId, event, receivedAt);
  return { handled: true, accepted: true, eventId, receivedAt };
}
