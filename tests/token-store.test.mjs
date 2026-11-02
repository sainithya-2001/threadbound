import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedTokenStore, TokenStoreError } from '../token-store.mjs';

const session = {
  accessToken: 'access-token-test-value-should-not-be-plaintext',
  refreshToken: 'refresh-token-test-value-should-not-be-plaintext',
  expiresAt: 1_900_000_000_000,
  scopes: ['user:read:chat'],
  user: { id: '12345', login: 'creator', display_name: 'Creator', profile_image_url: 'https://example.test/avatar.png' }
};

test('encrypted OAuth session persists across store instances without plaintext tokens', t => {
  const dir = mkdtempSync(join(tmpdir(), 'threadbound-token-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'tokens.sqlite');
  const key = Buffer.alloc(32, 4).toString('base64url');
  const first = new EncryptedTokenStore({ databasePath: path, encryptionKey: key });
  first.save(session);
  first.close();
  const bytes = readFileSync(path);
  assert.equal(bytes.includes(Buffer.from(session.accessToken)), false);
  assert.equal(bytes.includes(Buffer.from(session.refreshToken)), false);
  const reopened = new EncryptedTokenStore({ databasePath: path, encryptionKey: key });
  assert.deepEqual(reopened.load(), session);
  reopened.clear();
  assert.equal(reopened.load(), null);
  reopened.close();
});

test('token store rejects absent, malformed, and wrong encryption keys safely', t => {
  const dir = mkdtempSync(join(tmpdir(), 'threadbound-token-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => new EncryptedTokenStore({ databasePath: join(dir, 'missing.sqlite'), encryptionKey: '' }), TokenStoreError);
  const path = join(dir, 'tokens.sqlite');
  const store = new EncryptedTokenStore({ databasePath: path, encryptionKey: Buffer.alloc(32, 4).toString('base64url') });
  store.save(session);
  store.close();
  const wrongKeyStore = new EncryptedTokenStore({ databasePath: path, encryptionKey: Buffer.alloc(32, 5).toString('base64url') });
  assert.throws(() => wrongKeyStore.load(), error => error instanceof TokenStoreError && !error.message.includes(session.accessToken));
  wrongKeyStore.close();
});
