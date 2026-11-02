export class RaidEventStore {
  constructor({ maxEvents = 20, dedupeTtlMs = 6 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.maxEvents = maxEvents;
    this.dedupeTtlMs = dedupeTtlMs;
    this.now = now;
    this.events = [];
    this.seen = new Map();
  }

  add(event, messageId) {
    const now = this.now();
    for (const [id, expiry] of this.seen) if (expiry < now) this.seen.delete(id);
    if (!messageId || this.seen.has(messageId)) return false;
    this.seen.set(messageId, now + this.dedupeTtlMs);
    this.events.unshift({
      id: messageId,
      fromBroadcasterId: event.from_broadcaster_user_id,
      fromBroadcasterLogin: event.from_broadcaster_user_login,
      fromBroadcasterName: event.from_broadcaster_user_name,
      toBroadcasterId: event.to_broadcaster_user_id,
      toBroadcasterLogin: event.to_broadcaster_user_login,
      toBroadcasterName: event.to_broadcaster_user_name,
      viewers: Number(event.viewers) || 0,
      receivedAt: new Date(now).toISOString()
    });
    this.events.length = Math.min(this.events.length, this.maxEvents);
    return true;
  }

  list() { return this.events.slice(); }
  clear() { this.events.length = 0; this.seen.clear(); }
}
