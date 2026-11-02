import { timingSafeEqual } from 'node:crypto';

export function verifyOAuthState(queryState, cookieState, expiresAt, now = Date.now()) {
  if (typeof queryState !== 'string' || !queryState || typeof cookieState !== 'string' || !cookieState) return false;
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  const supplied = Buffer.from(queryState, 'utf8');
  const cookie = Buffer.from(cookieState, 'utf8');
  return supplied.length === cookie.length && timingSafeEqual(supplied, cookie);
}
