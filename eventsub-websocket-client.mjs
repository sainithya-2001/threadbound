import { getEventSubSessionId } from './eventsub-utils.mjs';
import { parseEventSubEnvelope } from './eventsub-raid-handler.mjs';

/**
 * THREADBOUND's production EventSub WebSocket lifecycle.
 * URL, WebSocket constructor, and welcome-time subscription API work are injected
 * so the exact client can be exercised against Twitch CLI without Twitch access.
 */
export class EventSubWebSocketClient {
  constructor({ WebSocketCtor = globalThis.WebSocket, subscriptionApi = {}, handlers = {} } = {}) {
    if (typeof WebSocketCtor !== 'function') throw new TypeError('A WebSocket constructor is required.');
    this.WebSocketCtor = WebSocketCtor;
    this.subscriptionApi = subscriptionApi;
    this.handlers = handlers;
    this.socket = null;
    this.sessionId = null;
    this.generation = 0;
    this.closed = false;
  }

  connect(url, { resume = false } = {}) {
    if (this.closed) throw new Error('EventSub WebSocket client is closed.');
    if (typeof url !== 'string' || !url) throw new TypeError('An EventSub WebSocket URL is required.');
    const previousSocket = this.socket;
    const generation = ++this.generation;
    const socket = new this.WebSocketCtor(url);
    this.socket = socket;
    this.handlers.onSocket?.(socket);

    socket.addEventListener('message', async message => {
      if (generation !== this.generation || this.closed) return;
      const envelope = parseEventSubEnvelope(message.data);
      if (!envelope) return;
      const type = envelope.metadata?.message_type;
      const payload = envelope.payload || {};

      if (type === 'session_welcome') {
        const sessionId = getEventSubSessionId(payload);
        this.sessionId = sessionId;
        try {
          await this.subscriptionApi.onWelcome?.({ sessionId, payload, resume });
        } catch (error) {
          this.handlers.onError?.(error);
          return;
        }
        if (previousSocket && previousSocket !== socket && previousSocket.readyState < 2) previousSocket.close();
        this.handlers.onWelcome?.({ sessionId, payload, resume });
      } else if (type === 'session_keepalive') {
        this.handlers.onKeepalive?.({ payload, envelope });
      } else if (type === 'notification') {
        this.handlers.onNotification?.({ envelope, payload });
      } else if (type === 'session_reconnect' && payload.session?.reconnect_url) {
        this.handlers.onReconnect?.({ url: payload.session.reconnect_url, payload });
        try { this.connect(payload.session.reconnect_url, { resume: true }); }
        catch (error) { this.handlers.onError?.(error); }
      } else if (type === 'revocation') {
        this.handlers.onRevocation?.({ payload, envelope });
      }
    });

    socket.addEventListener('close', event => {
      if (generation === this.generation && !this.closed) this.handlers.onClose?.({ event, socket });
    });
    socket.addEventListener('error', event => {
      if (generation === this.generation && !this.closed) this.handlers.onError?.(event);
    });
    return socket;
  }

  close() {
    this.closed = true;
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) socket.close();
  }
}
