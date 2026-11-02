import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const AAD_PREFIX = 'threadbound:oauth-session:v1:';

export class TokenStoreError extends Error {
  constructor(message) { super(message); this.name = 'TokenStoreError'; }
}

export function parseEncryptionKey(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TokenStoreError('THREADBOUND_ENCRYPTION_KEY is required.');
  const input = value.trim();
  let key;
  if (/^[\da-f]{64}$/i.test(input)) key = Buffer.from(input, 'hex');
  else {
    try { key = Buffer.from(input, 'base64url'); }
    catch { throw new TokenStoreError('THREADBOUND_ENCRYPTION_KEY must encode exactly 32 bytes.'); }
  }
  if (key.length !== 32) throw new TokenStoreError('THREADBOUND_ENCRYPTION_KEY must encode exactly 32 bytes.');
  return key;
}

export class EncryptedTokenStore {
  constructor({ databasePath, encryptionKey }) {
    if (!databasePath) throw new TokenStoreError('A SQLite database path is required.');
    this.key = parseEncryptionKey(encryptionKey);
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS oauth_session (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        broadcaster_id TEXT NOT NULL,
        login TEXT NOT NULL,
        display_name TEXT NOT NULL,
        profile_image_url TEXT,
        token_ciphertext BLOB NOT NULL,
        token_nonce BLOB NOT NULL,
        token_tag BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    try { chmodSync(databasePath, 0o600); } catch { /* Windows ACLs are inherited from the private workspace. */ }
  }

  save(session) {
    const user = session?.user;
    if (!user?.id || !user?.login || !user?.display_name) throw new TokenStoreError('A broadcaster profile is required.');
    if (typeof session.accessToken !== 'string' || !session.accessToken || typeof session.refreshToken !== 'string' || !session.refreshToken || !Number.isFinite(session.expiresAt)) {
      throw new TokenStoreError('Valid OAuth session fields are required.');
    }
    const nonce = randomBytes(12);
    const aad = Buffer.from(`${AAD_PREFIX}${user.id}`);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad);
    const scopes = Array.isArray(session.scopes) ? [...new Set(session.scopes.filter(scope => typeof scope === 'string'))] : [];
    const plaintext = Buffer.from(JSON.stringify({ accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt, scopes }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    plaintext.fill(0);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT OR REPLACE INTO oauth_session
        (singleton,broadcaster_id,login,display_name,profile_image_url,token_ciphertext,token_nonce,token_tag,updated_at)
        VALUES (1,?,?,?,?,?,?,?,?)`).run(
        user.id, user.login, user.display_name, user.profile_image_url || '', ciphertext, nonce, tag, new Date().toISOString()
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  load() {
    const row = this.db.prepare('SELECT * FROM oauth_session WHERE singleton = 1').get();
    if (!row) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.token_nonce);
      decipher.setAAD(Buffer.from(`${AAD_PREFIX}${row.broadcaster_id}`));
      decipher.setAuthTag(row.token_tag);
      const plaintext = Buffer.concat([decipher.update(row.token_ciphertext), decipher.final()]);
      let tokens;
      try { tokens = JSON.parse(plaintext.toString('utf8')); }
      finally { plaintext.fill(0); }
      if (typeof tokens.accessToken !== 'string' || typeof tokens.refreshToken !== 'string' || !Number.isFinite(tokens.expiresAt)) {
        throw new Error('Stored session payload is invalid.');
      }
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: Array.isArray(tokens.scopes) ? tokens.scopes : [],
        user: { id: row.broadcaster_id, login: row.login, display_name: row.display_name, profile_image_url: row.profile_image_url }
      };
    } catch {
      throw new TokenStoreError('Stored Twitch session could not be decrypted. Check THREADBOUND_ENCRYPTION_KEY or reconnect Twitch.');
    }
  }

  clear() {
    this.db.prepare('DELETE FROM oauth_session WHERE singleton = 1').run();
  }

  close() { this.db.close(); }
}
