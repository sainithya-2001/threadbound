export class InvalidRefreshTokenError extends Error {
  constructor() { super('Twitch rejected the refresh token. Reauthorization is required.'); this.name = 'InvalidRefreshTokenError'; }
}

export class TemporaryRefreshError extends Error {
  constructor(status = 0) { super(`Twitch token refresh is temporarily unavailable${status ? ` (HTTP ${status})` : ''}.`); this.name = 'TemporaryRefreshError'; this.status = status; }
}

export async function refreshOAuthTokens({ clientId, clientSecret, refreshToken, fetchImpl = fetch, now = Date.now }) {
  let response;
  try {
    response = await fetchImpl('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken })
    });
  } catch {
    throw new TemporaryRefreshError();
  }
  if (response.status === 400 || response.status === 401) throw new InvalidRefreshTokenError();
  if (!response.ok) throw new TemporaryRefreshError(response.status);
  let value;
  try { value = await response.json(); } catch { throw new TemporaryRefreshError(response.status); }
  if (typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string' || !Number.isFinite(value.expires_in)) {
    throw new TemporaryRefreshError(response.status);
  }
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: now() + value.expires_in * 1000
  };
}

export function tokenNeedsRefresh(session, now = Date.now(), marginMs = 5 * 60 * 1000) {
  return !Number.isFinite(session?.expiresAt) || session.expiresAt <= now + marginMs;
}

export async function refreshSessionIfNeeded(session, { refresh, persist, clear, now = Date.now(), marginMs = 5 * 60 * 1000 }) {
  if (!tokenNeedsRefresh(session, now, marginMs)) return { session, refreshed: false, reauthorizationRequired: false };
  try {
    const tokens = await refresh(session.refreshToken);
    const updated = { ...session, ...tokens };
    await persist(updated);
    return { session: updated, refreshed: true, reauthorizationRequired: false };
  } catch (error) {
    if (error instanceof InvalidRefreshTokenError) {
      await clear();
      return { session: null, refreshed: false, reauthorizationRequired: true };
    }
    throw error;
  }
}
