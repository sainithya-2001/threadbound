/** Bounded, in-memory receive-order windows. Message identity is intentionally discarded. */
export class ChatContextWindows {
  constructor({ preWindowMs = 5 * 60_000, postWindowMs = 3 * 60_000, maxMessages = 160, now } = {}) {
    this.preWindowMs = preWindowMs;
    this.postWindowMs = postWindowMs;
    this.maxMessages = maxMessages;
    this.usesSystemClock = !now;
    this.now = now || (() => Date.now());
    this.pre = [];
    this.active = null;
    this.seenIds = new Map();
    this.seenRaidIds = new Map();
    this.expiryTimer = null;
  }

  add(event, messageId) {
    const now = this.now();
    this.prune(now);
    if (typeof messageId !== 'string' || !messageId || this.seenIds.has(messageId)) return false;
    const text = typeof event?.message?.text === 'string' ? event.message.text.trim() : '';
    if (!text) return false;
    this.seenIds.set(messageId, now + Math.max(this.preWindowMs, this.postWindowMs) + 60_000);
    while (this.seenIds.size > this.maxMessages * 4) this.seenIds.delete(this.seenIds.keys().next().value);
    // Do not retain Twitch chatter names, IDs, badges, or other viewer details.
    const message = { text, receivedAt: now };
    this.pre.push(message);
    this.trim(this.pre);
    if (this.active && now <= this.active.postUntil) {
      this.active.post.push(message);
      this.trim(this.active.post);
    }
    this.armExpiry();
    return true;
  }

  beginRaid(raidId, receivedAt = this.now()) {
    this.prune(receivedAt);
    if (typeof raidId !== 'string' || !raidId || this.seenRaidIds.has(raidId)) return false;
    this.seenRaidIds.set(raidId, receivedAt + 6 * 60 * 60_000);
    while (this.seenRaidIds.size > 128) this.seenRaidIds.delete(this.seenRaidIds.keys().next().value);
    const cutoff = receivedAt - this.preWindowMs;
    const frozenPre = this.pre.filter(message => message.receivedAt >= cutoff && message.receivedAt <= receivedAt).map(message => ({ ...message }));
    this.active = { raidId, raidAt: receivedAt, postUntil: receivedAt + this.postWindowMs, pre: frozenPre, post: [] };
    this.armExpiry();
    return true;
  }

  snapshot(now = this.now()) {
    this.prune(now);
    if (!this.active) return null;
    return { raidAt: this.active.raidAt, pre: this.active.pre.map(item => ({ ...item })), post: this.active.post.map(item => ({ ...item })) };
  }

  stats(now = this.now()) {
    this.prune(now);
    return {
      preCount: this.pre.length,
      postCount: this.active?.post.length || 0,
      activeRaidWindow: Boolean(this.active),
      postWindowOpen: Boolean(this.active && now <= this.active.postUntil)
    };
  }

  prune(now) {
    const cutoff = now - this.preWindowMs;
    this.pre = this.pre.filter(message => message.receivedAt >= cutoff);
    if (this.active && now > this.active.postUntil) this.active = null;
    for (const [id, expiresAt] of this.seenIds) if (expiresAt < now) this.seenIds.delete(id);
    for (const [id, expiresAt] of this.seenRaidIds) if (expiresAt < now) this.seenRaidIds.delete(id);
    this.armExpiry();
  }

  trim(messages) {
    if (messages.length > this.maxMessages) messages.splice(0, messages.length - this.maxMessages);
  }

  clear() {
    this.pre.length = 0;
    this.active = null;
    this.seenIds.clear();
    this.seenRaidIds.clear();
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  armExpiry() {
    if (!this.usesSystemClock) return;
    clearTimeout(this.expiryTimer);
    const deadlines = this.pre.map(message => message.receivedAt + this.preWindowMs + 1);
    if (this.active) deadlines.push(this.active.postUntil + 1);
    if (!deadlines.length) { this.expiryTimer = null; return; }
    const delay = Math.max(1, Math.min(...deadlines) - this.now());
    this.expiryTimer = setTimeout(() => this.prune(this.now()), delay);
    this.expiryTimer.unref?.();
  }
}

export function buildChatMessageSubscriptionRequest(broadcasterId, userId, sessionId) {
  if (!broadcasterId || !userId || !sessionId) throw new Error('Broadcaster ID, chatting user ID, and EventSub session ID are required.');
  return {
    type: 'channel.chat.message',
    version: '1',
    condition: { broadcaster_user_id: broadcasterId, user_id: userId },
    transport: { method: 'websocket', session_id: sessionId }
  };
}

export function hasChatReadPermission(scopes) {
  return Array.isArray(scopes) && scopes.includes('user:read:chat');
}

export function assessChatMessageSubscription(subscriptions, broadcasterId, userId, sessionId) {
  const candidates = subscriptions.filter(item => item.type === 'channel.chat.message' && item.version === '1' &&
    item.condition?.broadcaster_user_id === broadcasterId && item.condition?.user_id === userId);
  const subscription = candidates.find(item => item.transport?.session_id === sessionId) || candidates[0] || null;
  const broadcasterMatches = Boolean(subscription);
  const sessionMatches = Boolean(subscription && sessionId && subscription.transport?.session_id === sessionId);
  const enabled = Boolean(subscription?.status === 'enabled' && sessionMatches);
  return { subscription, broadcasterMatches, sessionMatches, enabled };
}
