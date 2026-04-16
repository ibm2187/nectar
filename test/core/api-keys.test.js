import { describe, it, expect, beforeEach } from 'vitest';

const ApiKeyManager = require('../../src/core/api-keys');
const { createTestDb } = require('../../src/core/db');

describe('ApiKeyManager', () => {
  let mgr;
  let db;

  beforeEach(() => {
    db = createTestDb();
    mgr = new ApiKeyManager({ db });
  });

  describe('create', () => {
    // TESTING: Creating a new API key
    // EXPECTED: Returns id, rawKey with nectar_ prefix, label, and timestamps
    it('creates a key with nectar_ prefix and returns raw key', () => {
      const result = mgr.create('test-key', 'user@test.com');

      expect(result.id).toMatch(/^key-/);
      expect(result.rawKey).toMatch(/^nectar_/);
      expect(result.label).toBe('test-key');
      expect(result.createdBy).toBe('user@test.com');
      expect(result.createdAt).toBeTruthy();
    });

    // TESTING: Raw key is base64url encoded 32 bytes after prefix
    // EXPECTED: The portion after nectar_ should be valid base64url
    it('generates a sufficiently long random key', () => {
      const result = mgr.create('test-key');
      const keyBody = result.rawKey.replace('nectar_', '');
      // base64url of 32 bytes = 43 characters
      expect(keyBody.length).toBeGreaterThanOrEqual(40);
    });

    // TESTING: Key is stored hashed, not in plaintext
    // EXPECTED: The stored hash should not contain the raw key
    it('stores key as SHA-256 hash', () => {
      const result = mgr.create('test-key');
      const stored = mgr.keys.get(result.id);
      expect(stored.hash).toBeTruthy();
      expect(stored.hash).not.toBe(result.rawKey);
      expect(stored.hash).toHaveLength(64); // SHA-256 hex digest
    });

    // TESTING: Label is required
    // EXPECTED: Throws an error when label is empty
    it('throws when label is empty', () => {
      expect(() => mgr.create('')).toThrow('Label is required');
      expect(() => mgr.create('  ')).toThrow('Label is required');
    });
  });

  describe('validate', () => {
    // TESTING: Validating a correct raw key
    // EXPECTED: Returns valid: true with the key ID and label
    it('validates a correct raw key', () => {
      const { rawKey, id } = mgr.create('my-key');
      const result = mgr.validate(rawKey);

      expect(result.valid).toBe(true);
      expect(result.keyId).toBe(id);
      expect(result.label).toBe('my-key');
    });

    // TESTING: Validating an incorrect key
    // EXPECTED: Returns valid: false
    it('rejects an incorrect key', () => {
      mgr.create('my-key');
      const result = mgr.validate('nectar_wrongkey123456789012345678901234567890');

      expect(result.valid).toBe(false);
      expect(result.keyId).toBeNull();
    });

    // TESTING: Validating a key without the nectar_ prefix
    // EXPECTED: Returns valid: false immediately
    it('rejects keys without nectar_ prefix', () => {
      const result = mgr.validate('some-other-token');
      expect(result.valid).toBe(false);
    });

    // TESTING: Null/undefined key
    // EXPECTED: Returns valid: false
    it('handles null/undefined', () => {
      expect(mgr.validate(null).valid).toBe(false);
      expect(mgr.validate(undefined).valid).toBe(false);
      expect(mgr.validate('').valid).toBe(false);
    });

    // TESTING: lastUsedAt is updated on validation
    // EXPECTED: After validation, the key's lastUsedAt should be set
    it('updates lastUsedAt on successful validation', () => {
      const { rawKey, id } = mgr.create('my-key');
      const before = mgr.keys.get(id).lastUsedAt;
      expect(before).toBeNull();

      mgr.validate(rawKey);

      // Check both in-memory mirror and the DB agree
      const after = mgr.keys.get(id).lastUsedAt;
      expect(after).toBeTruthy();

      const fromDb = db.prepare('SELECT lastUsedAt FROM api_keys WHERE id = ?').get(id);
      expect(fromDb.lastUsedAt).toBe(after);
    });
  });

  describe('list', () => {
    // TESTING: Listing keys returns metadata without hashes
    // EXPECTED: Each key has id, label, createdAt but NOT hash
    it('lists keys without hashes', () => {
      mgr.create('key-1', 'user1@test.com');
      mgr.create('key-2', 'user2@test.com');

      const list = mgr.list();
      expect(list).toHaveLength(2);
      expect(list[0]).toHaveProperty('id');
      expect(list[0]).toHaveProperty('label');
      expect(list[0]).toHaveProperty('createdAt');
      expect(list[0]).not.toHaveProperty('hash');
    });

    // TESTING: List is sorted newest first
    // EXPECTED: The most recently created key is first
    it('sorts newest first', () => {
      const older = mgr.create('older-key');
      const newer = mgr.create('newer-key');
      // Force a newer timestamp on the second key in the DB
      db.prepare('UPDATE api_keys SET createdAt = ? WHERE id = ?')
        .run(new Date(Date.now() + 1000).toISOString(), newer.id);

      const list = mgr.list();
      expect(list[0].label).toBe('newer-key');
      expect(list[1].label).toBe('older-key');
    });
  });

  describe('revoke', () => {
    // TESTING: Revoking a key removes it
    // EXPECTED: The key is no longer valid and not in the list
    it('revokes a key so it is no longer valid', () => {
      const { rawKey, id } = mgr.create('to-revoke');
      expect(mgr.validate(rawKey).valid).toBe(true);

      const deleted = mgr.revoke(id);
      expect(deleted).toBe(true);
      expect(mgr.validate(rawKey).valid).toBe(false);
      expect(mgr.list()).toHaveLength(0);
    });

    // TESTING: Revoking a non-existent key
    // EXPECTED: Returns false
    it('returns false for non-existent key', () => {
      expect(mgr.revoke('key-nonexistent')).toBe(false);
    });
  });

  describe('middleware', () => {
    // TESTING: Express middleware sets req.apiKey on valid API key
    // EXPECTED: req.apiKey is set with keyId and label
    it('sets req.apiKey for valid API key in Authorization header', () => {
      const { rawKey } = mgr.create('middleware-key');
      const mw = mgr.middleware();

      const req = { headers: { authorization: `Bearer ${rawKey}` } };
      const res = {};
      let called = false;
      const next = () => { called = true; };

      mw(req, res, next);

      expect(called).toBe(true);
      expect(req.apiKey).toBeTruthy();
      expect(req.apiKey.label).toBe('middleware-key');
      expect(req.authenticated).toBe(true);
    });

    // TESTING: Middleware passes through for non-API-key tokens
    // EXPECTED: next() is called, req.apiKey is not set
    it('passes through for non-nectar_ tokens', () => {
      const mw = mgr.middleware();

      const req = { headers: { authorization: 'Bearer some-other-token' } };
      const res = {};
      let called = false;
      const next = () => { called = true; };

      mw(req, res, next);

      expect(called).toBe(true);
      expect(req.apiKey).toBeUndefined();
    });

    // TESTING: Middleware passes through when no Authorization header
    // EXPECTED: next() is called
    it('passes through when no auth header', () => {
      const mw = mgr.middleware();

      const req = { headers: {} };
      const res = {};
      let called = false;
      const next = () => { called = true; };

      mw(req, res, next);

      expect(called).toBe(true);
    });
  });

  describe('persistence', () => {
    // TESTING: A new manager loads keys previously created into the same DB
    // EXPECTED: After reopening, keys are still validatable and listed
    it('reloads keys across instances', () => {
      const { rawKey } = mgr.create('persistent', 'nukul@test.com');

      const mgr2 = new ApiKeyManager({ db });
      expect(mgr2.list()).toHaveLength(1);
      expect(mgr2.validate(rawKey).valid).toBe(true);
    });
  });
});
