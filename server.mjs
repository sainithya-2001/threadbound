import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { EncryptedTokenStore, TokenStoreError } from './token-store.mjs';
import { InvalidRefreshTokenError, refreshOAuthTokens, tokenNeedsRefresh } from './oauth-refresh.mjs';
import { RaidEventStore } from './raid-events.mjs';
import { verifyOAuthState } from './oauth-state.mjs';
import { assessRaidSubscription, buildRaidSubscriptionRequest, getEventSubSessionId } from './eventsub-utils.mjs';
import { assessChatMessageSubscription, buildChatMessageSubscriptionRequest, ChatContextWindows, hasChatReadPermission } from './chat-context.mjs';

try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const root = fileURLToPath(new URL('.', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 4173);
const configuredRedirect = process.env.TWITCH_REDIRECT_URI;
const inferredBase = configuredRedirect ? new URL(configuredRedirect).origin : `http://localhost:${PORT}`;
const APP_BASE_URL = new URL(process.env.APP_BASE_URL || inferredBase);
if (!['http:', 'https:'].includes(APP_BASE_URL.protocol)) throw new Error('APP_BASE_URL must use http or https.');
const REDIRECT_URI = `${APP_BASE_URL.origin}/auth/twitch/callback`;
const CHAT_SCOPE = 'user:read:chat';

// OAuth tokens are encrypted in SQLite and are only used server-side.
let twitch = null;
let eventSocket = null;
let eventGeneration = 0;
let reconnectTimer = null;
let sessionKeepaliveTimer = null;
let tokenRefreshTimer = null;
let resumeSubscriptions = false;
let eventSubConnectionState = 'disconnected';
let eventSubSessionId = null;
let raidSubscriptionState = { status: 'not_created', enabled: false, broadcasterMatches: false, verifiedAt: null, error: null };
let chatSubscriptionState = { status: 'permission_required', enabled: false, broadcasterMatches: false, sessionMatches: false, verifiedAt: null, error: null };
let lastKeepalive = Date.now();
let status = 'demo';
let reauthorizationRequired = false;
let tokenStore = null;
let tokenStoreReady = false;
try {
  if (CLIENT_ID && CLIENT_SECRET) {
    const databasePath = process.env.THREADBOUND_TOKEN_DB || join(root, 'data', 'threadbound.sqlite');
    tokenStore = new EncryptedTokenStore({ databasePath, encryptionKey: process.env.THREADBOUND_ENCRYPTION_KEY });
    tokenStoreReady = true;
  }
} catch (error) {
  console.error(error instanceof TokenStoreError ? error.message : 'Encrypted OAuth storage could not be initialized.');
}
const raidEvents = new RaidEventStore();
const chatWindows = new ChatContextWindows();
const oauthStates = new Map();

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function cookieValue(req, name) {
  return (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
function setCookie(res, value, maxAge = 600) {
  const secure = APP_BASE_URL.protocol === 'https:' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `rb_oauth=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}
function publicState() {
  return {
    configured: Boolean(CLIENT_ID && CLIENT_SECRET),
    tokenStorageReady: tokenStoreReady,
    oauthCanStart: Boolean(CLIENT_ID),
    connected: Boolean(twitch), reauthorizationRequired, status,
    broadcaster: twitch ? { id: twitch.user.id, login: twitch.user.login, name: twitch.user.display_name, profileImageUrl: twitch.user.profile_image_url } : null,
    eventSub: { connected: eventSubConnectionState === 'connected' && eventSocket?.readyState === WebSocket.OPEN, status: eventSubConnectionState },
    raidSubscription: { ...raidSubscriptionState },
    chat: {
      status: !twitch ? 'not_connected' : !hasChatReadPermission(twitch.scopes) ? 'permission_required' :
        (eventSubConnectionState !== 'connected' && chatSubscriptionState.status !== 'error' ? 'waiting_for_eventsub' : chatSubscriptionState.status),
      authorized: hasChatReadPermission(twitch?.scopes),
      subscriptionEnabled: chatSubscriptionState.enabled,
      collectionActive: Boolean(hasChatReadPermission(twitch?.scopes) && chatSubscriptionState.enabled && eventSubConnectionState === 'connected'),
      window: chatWindows.stats()
    },
    raids: raidEvents.list()
  };
}
async function twitchRequest(path, token = twitch?.accessToken, init = {}) {
  const response = await fetch(`https://api.twitch.tv/helix/${path}`, {
    ...init,
    headers: { 'Client-Id': CLIENT_ID, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Twitch API request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}
async function validateToken(accessToken) {
  const response = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } });
  if (!response.ok) throw new Error('Twitch returned an invalid access token. Please reconnect.');
  const value = await response.json();
  if (value.client_id !== CLIENT_ID) throw new Error('Token client does not match this Twitch application.');
  return value;
}
async function createRaidSubscription(sessionId) {
  if (!sessionId) throw new Error('EventSub Welcome message did not include a session ID.');
  raidSubscriptionState = { status: 'creating', enabled: false, broadcasterMatches: false, verifiedAt: null, error: null };
  const created = await twitchRequest('eventsub/subscriptions', twitch.accessToken, {
    method: 'POST', body: JSON.stringify(buildRaidSubscriptionRequest(twitch.user.id, sessionId))
  });
  const createdSubscription = created.data?.find(item => item.type === 'channel.raid') || created.data?.[0];
  if (!createdSubscription || createdSubscription.condition?.to_broadcaster_user_id !== twitch.user.id) {
    throw new Error('Twitch did not confirm a channel.raid subscription for the authenticated broadcaster.');
  }
  raidSubscriptionState = { status: createdSubscription.status || 'created', enabled: false, broadcasterMatches: true, verifiedAt: null, error: null };
  await verifyRaidSubscription(sessionId);
}
async function verifyRaidSubscription(sessionId = eventSubSessionId) {
  if (!twitch || !sessionId) return;
  const result = await twitchRequest('eventsub/subscriptions?type=channel.raid');
  const assessed = assessRaidSubscription(result.data || [], twitch.user.id, sessionId);
  raidSubscriptionState = {
    status: assessed.subscription?.status || 'not_found',
    enabled: assessed.enabled,
    broadcasterMatches: assessed.broadcasterMatches,
    verifiedAt: new Date().toISOString(),
    error: assessed.subscription && !assessed.sessionMatches ? 'Subscription is attached to a different EventSub session.' : null
  };
  status = assessed.enabled ? 'listening' : 'subscription_error';
  console.log(`Twitch confirmed channel.raid status=${raidSubscriptionState.status} broadcaster_match=${assessed.broadcasterMatches} session_match=${assessed.sessionMatches}`);
  if (!assessed.subscription) throw new Error('Twitch API did not return the expected channel.raid subscription.');
  if (!assessed.sessionMatches) throw new Error('Twitch API subscription session did not match the active WebSocket session.');
  if (!assessed.enabled) throw new Error(`Twitch reports channel.raid subscription status: ${assessed.subscription.status}.`);
}
async function ensureChatSubscription(sessionId = eventSubSessionId) {
  if (!twitch) return;
  if (!hasChatReadPermission(twitch.scopes)) {
    chatSubscriptionState = { status: 'permission_required', enabled: false, broadcasterMatches: false, sessionMatches: false, verifiedAt: null, error: null };
    return;
  }
  if (!sessionId) {
    chatSubscriptionState = { ...chatSubscriptionState, status: 'waiting_for_eventsub', enabled: false };
    return;
  }
  chatSubscriptionState = { ...chatSubscriptionState, status: 'subscribing', enabled: false, error: null };
  try {
    let response = await twitchRequest('eventsub/subscriptions?type=channel.chat.message');
    let assessed = assessChatMessageSubscription(response.data || [], twitch.user.id, twitch.user.id, sessionId);
    if (!assessed.enabled) {
      await twitchRequest('eventsub/subscriptions', twitch.accessToken, {
        method: 'POST', body: JSON.stringify(buildChatMessageSubscriptionRequest(twitch.user.id, twitch.user.id, sessionId))
      });
      response = await twitchRequest('eventsub/subscriptions?type=channel.chat.message');
      assessed = assessChatMessageSubscription(response.data || [], twitch.user.id, twitch.user.id, sessionId);
    }
    chatSubscriptionState = {
      status: assessed.subscription?.status || 'not_found',
      enabled: assessed.enabled,
      broadcasterMatches: assessed.broadcasterMatches,
      sessionMatches: assessed.sessionMatches,
      verifiedAt: new Date().toISOString(),
      error: assessed.subscription && !assessed.sessionMatches ? 'Chat subscription is attached to a different EventSub session.' : null
    };
  } catch (error) {
    const permissionDenied = (error?.status === 401 || error?.status === 403) && !twitch?.scopes?.includes(CHAT_SCOPE);
    chatSubscriptionState = {
      ...chatSubscriptionState,
      status: permissionDenied ? 'permission_required' : 'error',
      enabled: false,
      verifiedAt: new Date().toISOString(),
      error: permissionDenied ? 'Twitch denied chat access. Reauthorize with the requested chat permission.' : 'Chat subscription could not be verified.'
    };
    if (permissionDenied) console.warn('Twitch denied the channel.chat.message subscription; broadcaster chat authorization is required.');
    else console.error('Twitch channel.chat.message subscription check failed.');
  }
}
function scheduleTokenRefresh(delayOverride) {
  clearTimeout(tokenRefreshTimer);
  if (!twitch) return;
  tokenRefreshTimer = setTimeout(async () => {
    if (!twitch) return;
    try {
      const refreshed = await refreshOAuthTokens({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: twitch.refreshToken });
      const updated = { ...twitch, ...refreshed };
      tokenStore?.save(updated);
      twitch = updated;
      scheduleTokenRefresh();
    } catch (error) {
      if (error instanceof InvalidRefreshTokenError) {
        disconnect({ clearPersisted: true });
        reauthorizationRequired = true;
        status = 'reauthorization_required';
      } else {
        console.error('Twitch token refresh temporarily failed; the session remains stored securely.');
        scheduleTokenRefresh(60_000);
      }
    }
  }, Math.max(10_000, delayOverride ?? twitch.expiresAt - Date.now() - 5 * 60 * 1000));
  tokenRefreshTimer.unref?.();
}
function scheduleReconnect(delay = 1500) {
  clearTimeout(reconnectTimer);
  if (!twitch) return;
  reconnectTimer = setTimeout(() => connectEventSub(), delay);
  reconnectTimer.unref?.();
}
function clearKeepalive() { clearTimeout(sessionKeepaliveTimer); }
function armKeepalive(timeoutSeconds) {
  clearKeepalive();
  sessionKeepaliveTimer = setTimeout(() => {
    if (Date.now() - lastKeepalive >= timeoutSeconds * 1000 && eventSocket?.readyState === WebSocket.OPEN) eventSocket.close();
  }, timeoutSeconds * 1000 + 1000);
  sessionKeepaliveTimer.unref?.();
}
function connectEventSub(url = 'wss://eventsub.wss.twitch.tv/ws', resume = false) {
  if (!twitch) return;
  const generation = ++eventGeneration;
  resumeSubscriptions = resume;
  status = 'connecting';
  eventSubConnectionState = 'connecting';
  if (!resume) eventSubSessionId = null;
  let socket;
  try { socket = new WebSocket(url); }
  catch { status = 'reconnecting'; scheduleReconnect(); return; }
  eventSocket = socket;
  socket.addEventListener('message', async message => {
    if (generation !== eventGeneration) return;
    let envelope;
    try { envelope = JSON.parse(message.data); } catch { return; }
    const type = envelope.metadata?.message_type;
    const payload = envelope.payload || {};
    if (type === 'session_welcome') {
      lastKeepalive = Date.now();
      armKeepalive(payload.session?.keepalive_timeout_seconds || 10);
      eventSubSessionId = getEventSubSessionId(payload);
      eventSubConnectionState = payload.session?.status === 'connected' || payload.session?.status == null ? 'connected' : payload.session.status;
      if (resumeSubscriptions) {
        resumeSubscriptions = false;
        try { await verifyRaidSubscription(eventSubSessionId); }
        catch (error) { console.error('EventSub subscription verification failed:', error.message); status = 'subscription_error'; raidSubscriptionState = { ...raidSubscriptionState, enabled: false, error: error.message }; }
        await ensureChatSubscription(eventSubSessionId);
        return;
      }
      try { await createRaidSubscription(eventSubSessionId); }
      catch (error) {
        console.error('EventSub subscription failed:', error.message);
        status = 'subscription_error';
        raidSubscriptionState = { ...raidSubscriptionState, status: 'error', enabled: false, error: error.message };
      }
      await ensureChatSubscription(eventSubSessionId);
    } else if (type === 'session_keepalive') {
      lastKeepalive = Date.now();
      armKeepalive(payload.session?.keepalive_timeout_seconds || 10);
      eventSubConnectionState = 'connected';
    } else if (type === 'notification' && payload.subscription?.type === 'channel.raid') {
      const eventId = envelope.metadata?.message_id || randomBytes(12).toString('hex');
      const event = payload.event || {};
      if (raidEvents.add(event, eventId) && event.to_broadcaster_user_id === twitch?.user.id) chatWindows.beginRaid(eventId);
    } else if (type === 'notification' && payload.subscription?.type === 'channel.chat.message') {
      if (chatSubscriptionState.enabled && payload.event?.broadcaster_user_id === twitch?.user.id) {
        chatWindows.add(payload.event, payload.event?.message_id || envelope.metadata?.message_id);
      }
    } else if (type === 'session_reconnect' && payload.session?.reconnect_url) {
      clearKeepalive();
      eventSubConnectionState = 'reconnecting';
      connectEventSub(payload.session.reconnect_url, true);
    } else if (type === 'revocation') {
      console.warn('EventSub subscription was revoked.');
      if (payload.subscription?.type === 'channel.chat.message') {
        chatSubscriptionState = { ...chatSubscriptionState, status: payload.subscription?.status || 'revoked', enabled: false, error: 'Twitch revoked the chat subscription.' };
      } else {
        status = 'subscription_error';
        raidSubscriptionState = { ...raidSubscriptionState, status: payload.subscription?.status || 'revoked', enabled: false, error: 'Twitch revoked the EventSub subscription.' };
      }
    }
  });
  socket.addEventListener('close', () => {
    if (generation !== eventGeneration) return;
    clearKeepalive();
    eventSubConnectionState = twitch ? 'reconnecting' : 'disconnected';
    if (twitch) {
      status = 'reconnecting';
      raidSubscriptionState = { ...raidSubscriptionState, status: 'reconnecting', enabled: false, error: 'WebSocket closed; waiting for a new session.' };
      if (hasChatReadPermission(twitch?.scopes)) chatSubscriptionState = { ...chatSubscriptionState, status: 'reconnecting', enabled: false, error: null };
      scheduleReconnect();
    }
  });
  socket.addEventListener('error', () => {
    if (generation === eventGeneration && twitch) { status = 'reconnecting'; eventSubConnectionState = 'reconnecting'; }
  });
}
function disconnect({ clearPersisted = false } = {}) {
  twitch = null;
  status = 'demo';
  eventSubConnectionState = 'disconnected';
  eventSubSessionId = null;
  raidSubscriptionState = { status: 'not_created', enabled: false, broadcasterMatches: false, verifiedAt: null, error: null };
  eventGeneration++;
  clearTimeout(reconnectTimer); clearKeepalive(); clearTimeout(tokenRefreshTimer);
  if (eventSocket && eventSocket.readyState < WebSocket.CLOSING) eventSocket.close();
  eventSocket = null;
  raidEvents.clear();
  chatWindows.clear();
  chatSubscriptionState = { status: 'permission_required', enabled: false, broadcasterMatches: false, sessionMatches: false, verifiedAt: null, error: null };
  if (clearPersisted) {
    try { tokenStore?.clear(); } catch { console.error('Could not clear the encrypted Twitch session store.'); }
  }
}
function htmlMessage(title, message) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="background:#101319;color:#edece8;font:16px system-ui;padding:48px"><h1>${title}</h1><p>${message}</p><p><a style="color:#b7f288" href="${APP_BASE_URL.origin}/auth/twitch">Try Twitch connection again</a></p><p><a style="color:#b7f288" href="${APP_BASE_URL.origin}/">Return to THREADBOUND</a></p></body>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/twitch/status' && req.method === 'GET') return json(res, 200, publicState());
    if (url.pathname === '/api/twitch/disconnect' && req.method === 'POST') { disconnect({ clearPersisted: true }); reauthorizationRequired = false; return json(res, 200, publicState()); }
    if (url.pathname === '/auth/twitch' && req.method === 'GET') {
      if (!CLIENT_ID) return json(res, 503, { error: 'Add TWITCH_CLIENT_ID to the server environment first.' });
      if (CLIENT_SECRET && !tokenStoreReady) return json(res, 503, { error: 'Encrypted token storage is unavailable. Configure THREADBOUND_ENCRYPTION_KEY and restart THREADBOUND.' });
      if (url.origin !== APP_BASE_URL.origin) {
        res.writeHead(302, { Location: `${APP_BASE_URL.origin}/auth/twitch`, 'Cache-Control': 'no-store' }); return res.end();
      }
      for (const [pendingState, expiry] of oauthStates) if (expiry < Date.now()) oauthStates.delete(pendingState);
      const state = randomBytes(32).toString('hex');
      oauthStates.set(state, Date.now() + 10 * 60 * 1000);
      setCookie(res, state);
      const authorize = new URL('https://id.twitch.tv/oauth2/authorize');
      authorize.search = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: CHAT_SCOPE, state }).toString();
      res.writeHead(302, { Location: authorize.toString(), 'Cache-Control': 'no-store' }); return res.end();
    }
    if (url.pathname === '/auth/twitch/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state') || '';
      const expires = oauthStates.get(state);
      oauthStates.delete(state);
      setCookie(res, '', 0);
      if (url.origin !== APP_BASE_URL.origin) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(htmlMessage('Use the same THREADBOUND address', `This sign-in started at ${APP_BASE_URL.origin}. Open the callback there so the browser can send the matching security cookie.`));
      }
      if (!verifyOAuthState(state, cookieValue(req, 'rb_oauth'), expires)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(htmlMessage('Connection could not be verified', `The sign-in security check did not match. This can happen if the callback used a different hostname (localhost and 127.0.0.1 have separate cookies), the cookie was blocked, or the attempt expired. Restart sign-in from ${APP_BASE_URL.origin} and complete it in the same browser.`));
      }
      if (!CLIENT_SECRET) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(htmlMessage('Finish local Twitch setup', 'The sign-in returned successfully, but the server has no Twitch Client Secret yet. Add it to the local .env file, restart THREADBOUND, and start a new connection.'));
      }
      if (url.searchParams.has('error')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(htmlMessage('Twitch connection cancelled', 'Twitch authorization was not granted. You can retry the connection below.'));
      }
      try {
        const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: url.searchParams.get('code') || '', grant_type: 'authorization_code', redirect_uri: REDIRECT_URI })
        });
        const token = await tokenResponse.json();
        if (!tokenResponse.ok) throw new Error('Twitch token exchange failed.');
        const validated = await validateToken(token.access_token);
        const users = await twitchRequest(`users?id=${encodeURIComponent(validated.user_id)}`, token.access_token);
        if (!users.data?.[0]) throw new Error('Could not retrieve the authorized broadcaster profile.');
        if (users.data[0].id !== validated.user_id) throw new Error('The Twitch profile ID did not match the OAuth-authenticated account.');
        const session = { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000, scopes: validated.scopes || [], user: users.data[0] };
        if (!tokenStoreReady) throw new Error('Encrypted token storage is unavailable.');
        tokenStore.save(session);
        const keepEventSub = twitch?.user.id === session.user.id && eventSubConnectionState === 'connected' && eventSocket?.readyState === WebSocket.OPEN && eventSubSessionId;
        if (keepEventSub) {
          twitch = session;
          scheduleTokenRefresh();
          await ensureChatSubscription(eventSubSessionId);
        } else {
          disconnect();
          twitch = session;
          connectEventSub();
        }
        reauthorizationRequired = false;
        res.writeHead(302, { Location: `${APP_BASE_URL.origin}/`, 'Cache-Control': 'no-store' }); return res.end();
      } catch (error) {
        console.error('Twitch OAuth callback failed; check local Twitch setup and encrypted storage.');
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(htmlMessage('Twitch connection failed', 'The Twitch API could not complete the connection. Check the server terminal and try again.'));
      }
    }
    const pathname = decodeURIComponent(url.pathname);
    const file = normalize(join(root, pathname === '/' ? 'index.html' : pathname.slice(1)));
    if (!file.startsWith(root)) throw new Error('Invalid path');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (error) {
    const code = error.code === 'ENOENT' ? 404 : 500;
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(code === 404 ? 'Not found' : 'Server error');
  }
});

async function restorePersistedSession() {
  if (!tokenStoreReady) return;
  let saved;
  try { saved = tokenStore.load(); }
  catch {
    status = 'storage_error';
    console.error('Stored Twitch session could not be opened. Check THREADBOUND_ENCRYPTION_KEY; no session data was changed.');
    return;
  }
  if (!saved) return;
  status = 'restoring';
  try {
    let session = saved;
    if (tokenNeedsRefresh(session)) {
      const refreshed = await refreshOAuthTokens({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: session.refreshToken });
      session = { ...session, ...refreshed };
      tokenStore.save(session);
    } else {
      try {
        const validated = await validateToken(session.accessToken);
        if (validated.user_id !== session.user.id) throw new Error('Stored broadcaster identity did not match the Twitch token.');
      }
      catch {
        const refreshed = await refreshOAuthTokens({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: session.refreshToken });
        session = { ...session, ...refreshed };
        tokenStore.save(session);
      }
    }
    const validated = await validateToken(session.accessToken);
    if (validated.user_id !== session.user.id) throw new Error('Stored broadcaster identity did not match the Twitch token.');
    session.scopes = validated.scopes || [];
    const users = await twitchRequest(`users?id=${encodeURIComponent(session.user.id)}`, session.accessToken);
    const user = users.data?.[0];
    if (!user || user.id !== session.user.id) throw new Error('Broadcaster identity could not be verified.');
    session.user = user;
    tokenStore.save(session);
    twitch = session;
    reauthorizationRequired = false;
    status = 'connecting';
    scheduleTokenRefresh();
    connectEventSub();
  } catch (error) {
    if (error instanceof InvalidRefreshTokenError) {
      tokenStore.clear();
      reauthorizationRequired = true;
      status = 'reauthorization_required';
      console.warn('Stored Twitch refresh token was rejected; reconnect Twitch from the dashboard.');
      return;
    }
    // Keep the encrypted session on transient failures so the next restart/retry can recover it.
    status = 'restore_error';
    console.error('Twitch session restoration failed temporarily; the encrypted session was retained.');
    setTimeout(restorePersistedSession, 60_000).unref?.();
  }
}

server.listen(PORT, HOST, () => {
  console.log(`THREADBOUND listening on ${HOST}:${PORT}`);
  if (CLIENT_ID && CLIENT_SECRET) console.log(`Twitch OAuth configured; redirect URI: ${REDIRECT_URI}`);
  else if (CLIENT_ID) console.log('Twitch authorization can start; add the Client Secret locally to complete token exchange.');
  else console.log('Twitch app Client ID not configured; demo mode is available.');
  if (tokenStoreReady) void restorePersistedSession();
});
