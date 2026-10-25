// @vitest-environment node
// AI settings store (electron/ai/aiSettings.cjs) with a fake safeStorage, in temp folders only.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSafeStorage, OTHER_TEST_KEY, TEST_KEY } from '../helpers/fakeSafeStorage.js';
import { createTempDir } from '../helpers/tempDir.js';

const require = createRequire(import.meta.url);
const { createAiSettings, FILE_NAME } = require('../../electron/ai/aiSettings.cjs');
const { PROVIDERS } = require('../../electron/ai/providers.cjs');

const VERIFIED_AT = '2026-10-24T08:00:00.000Z';
let temp;
beforeEach(() => {
  temp = createTempDir();
});
afterEach(() => {
  temp.remove();
});

const open = (safeStorage = createFakeSafeStorage()) => createAiSettings({ dir: temp.dir, safeStorage });
const fileText = () => fs.readFileSync(temp.file(FILE_NAME), 'utf8');
const copies = (kind) => temp.list().filter((name) => name.startsWith('taskflow-ai.') && name.includes(kind));
const store = (settings, key = TEST_KEY, at = VERIFIED_AT) => settings.storeVerifiedKey('anthropic', key, at);
const encrypted = (key = TEST_KEY) => Buffer.from(createFakeSafeStorage().encryptString(key)).toString('base64');

describe('defaults', () => {
  it('AI is off, no key, nothing verified, and nothing is written until a change', () => {
    const state = open().publicState();
    expect(state).toEqual({ enabled: false, key: 'none', verifiedAt: null, secureStorage: 'available', status: 'new', writable: true, speech: { available: false }, advanced: { provider: null, model: null, compatible: null } });
    expect(temp.list()).toEqual([]);
  });

  it('the public state names no model; only the advanced section carries the provider id', () => {
    const settings = open();
    store(settings);
    expect(Object.keys(settings.publicState()).sort()).toEqual(['advanced', 'enabled', 'key', 'secureStorage', 'speech', 'status', 'verifiedAt', 'writable']);
    expect(settings.publicState().advanced).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', compatible: null });
    // Outside the advanced section nothing names a provider or model.
    const { advanced, ...rest } = settings.publicState();
    expect(JSON.stringify(rest)).not.toMatch(/anthropic|claude/i);
  });

  it('every provider descriptor is well-formed (provider-specific details stay in the registry)', () => {
    for (const provider of PROVIDERS) {
      expect(provider.model === null || typeof provider.model === 'string').toBe(true);
      expect(provider.keyHint === null || provider.keyHint instanceof RegExp).toBe(true);
      expect(typeof provider.isApiKeyFormat).toBe('function');
      expect(typeof provider.createAdapter).toBe('function'); // adapter code lives in providers/<id>.cjs
    }
  });
});

describe('verified API keys', () => {
  it('stores a verified key only encrypted, switches AI on and never returns the key', () => {
    const safeStorage = createFakeSafeStorage();
    const settings = open(safeStorage);
    expect(store(settings, `  ${TEST_KEY}  `)).toEqual({ ok: true });
    const state = settings.publicState();
    expect(state).toMatchObject({ key: 'stored', enabled: true, verifiedAt: VERIFIED_AT });
    expect(JSON.stringify(state)).not.toContain(TEST_KEY);
    expect(fileText()).not.toContain(TEST_KEY);
    expect(fileText()).not.toContain('sk-ant');
    // Round trip through the (fake) OS encryption, in a fresh instance.
    expect(open(safeStorage).getApiKey()).toBe(TEST_KEY);
    expect(open(safeStorage).getProviderId()).toBe('anthropic');
    expect(safeStorage.calls.encrypt).toBe(1);
  });

  it('replacing and removing a key; removing it also switches AI off and forgets the verification', () => {
    const settings = open();
    store(settings);
    store(settings, OTHER_TEST_KEY, '2026-10-25T09:00:00.000Z');
    expect(settings.getApiKey()).toBe(OTHER_TEST_KEY);
    expect(settings.publicState().verifiedAt).toBe('2026-10-25T09:00:00.000Z');
    expect(settings.clearApiKey()).toEqual({ ok: true });
    expect(settings.publicState()).toMatchObject({ key: 'none', enabled: false, verifiedAt: null });
    expect(settings.getApiKey()).toBeNull();
    expect(JSON.parse(fileText())).toEqual({ version: 1, enabled: false, provider: 'anthropic', verifiedAt: null, credentials: {}, compatible: null, models: {} });
  });

  it('markVerified updates the time of the last successful check, only with a stored key', () => {
    const settings = open();
    expect(settings.markVerified('2026-10-25T09:00:00.000Z')).toEqual({ ok: false, code: 'NO_KEY' });
    store(settings);
    expect(settings.markVerified('2026-10-25T09:00:00.000Z')).toEqual({ ok: true });
    expect(open().publicState().verifiedAt).toBe('2026-10-25T09:00:00.000Z');
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['another service', 'sk-proj-abcdefghijklmnopqrstuvwxyz'],
    ['too short', 'sk-ant-abc'],
    ['spaces inside', 'sk-ant-abcdefghij klmnopqrstuvwxyz'],
    ['not a string', 12345],
    ['too long', `sk-ant-${'a'.repeat(600)}`],
  ])('rejects an invalid key (%s) without storing anything', (_, key) => {
    expect(store(open(), key)).toEqual({ ok: false, code: 'INVALID_KEY' });
    expect(temp.list()).toEqual([]);
  });

  it('keys of different providers are stored side by side, each encrypted', () => {
    const settings = open();
    store(settings);
    expect(settings.storeVerifiedKey('openai', 'sk-proj-test-0123456789abcdefghij', VERIFIED_AT)).toEqual({ ok: true });
    const file = JSON.parse(fileText());
    expect(Object.keys(file.credentials).sort()).toEqual(['anthropic', 'openai']);
    expect(fileText()).not.toContain('sk-proj-test');
    expect(settings.getTarget()).toEqual({ providerId: 'openai', model: 'gpt-6-luna', baseUrl: null });
  });

  it('the OpenAI-compatible provider needs a valid address and model; it is stored as a setting', () => {
    const settings = open();
    expect(settings.storeVerifiedKey('openai-compatible', 'token', VERIFIED_AT, { baseUrl: 'http://example.test/v1', model: 'm' })).toEqual({ ok: false, code: 'INVALID_BASE_URL' });
    expect(settings.storeVerifiedKey('openai-compatible', 'token', VERIFIED_AT, { baseUrl: 'https://example.test/v1', model: '' })).toEqual({ ok: false, code: 'INVALID_MODEL' });
    expect(settings.storeVerifiedKey('openai-compatible', 'token', VERIFIED_AT, { baseUrl: 'https://example.test/v1/', model: 'm' })).toEqual({ ok: true });
    expect(JSON.parse(fileText()).compatible).toEqual({ baseUrl: 'https://example.test/v1', model: 'm' });
    expect(open().getTarget()).toEqual({ providerId: 'openai-compatible', model: 'm', baseUrl: 'https://example.test/v1' });
  });

  it('a stored compatible configuration that is not valid is repaired: the provider falls back and AI is off', () => {
    temp.writeJson(FILE_NAME, { version: 1, enabled: true, provider: 'openai-compatible', verifiedAt: VERIFIED_AT, credentials: { 'openai-compatible': encrypted('token') }, compatible: { baseUrl: 'http://evil.test', model: 'm' } });
    const settings = open();
    expect(settings.publicState()).toMatchObject({ status: 'repaired', enabled: false });
    expect(settings.getProviderId()).toBe('anthropic');
  });

  it('rejects an unknown provider id', () => {
    expect(open().storeVerifiedKey('mystery', TEST_KEY, VERIFIED_AT)).toEqual({ ok: false, code: 'UNSUPPORTED_KEY' });
    expect(temp.list()).toEqual([]);
  });

  it('refuses to store a key when secure storage is unavailable (no plaintext fallback)', () => {
    const settings = open(createFakeSafeStorage({ available: false }));
    expect(settings.publicState().secureStorage).toBe('unavailable');
    expect(settings.canStoreKey()).toEqual({ ok: false, code: 'SECURE_STORAGE_UNAVAILABLE' });
    expect(store(settings)).toEqual({ ok: false, code: 'SECURE_STORAGE_UNAVAILABLE' });
    expect(temp.list()).toEqual([]);
  });

  it("treats Linux's plaintext 'basic_text' backend as unavailable", () => {
    const settings = open(createFakeSafeStorage({ backend: 'basic_text' }));
    expect(settings.publicState().secureStorage).toBe('unavailable');
    expect(store(settings).code).toBe('SECURE_STORAGE_UNAVAILABLE');
  });

  it('a stored key that cannot be decrypted here is reported as unreadable, keeps AI off and is never returned', () => {
    store(open(createFakeSafeStorage()));
    const otherUser = createFakeSafeStorage({ failDecrypt: true });
    const settings = open(otherUser);
    expect(settings.publicState()).toMatchObject({ key: 'unreadable', enabled: false, status: 'repaired' });
    expect(settings.getApiKey()).toBeNull();
    expect(settings.saveSettings({ enabled: true })).toEqual({ ok: false, code: 'NOT_CONNECTED' });
    // A new verified key replaces it.
    otherUser.failDecrypt = false;
    expect(store(settings, OTHER_TEST_KEY)).toEqual({ ok: true });
    expect(settings.publicState().key).toBe('stored');
  });

  it('never stores a key that does not decrypt back to itself', () => {
    const broken = createFakeSafeStorage();
    broken.decryptString = () => 'something else';
    expect(store(open(broken))).toEqual({ ok: false, code: 'ENCRYPTION_FAILED' });
    expect(temp.list()).toEqual([]);
  });
});

describe('enabling', () => {
  it('enabling requires a key that passed a connection test; disabling is always possible', () => {
    const settings = open();
    expect(settings.saveSettings({ enabled: true })).toEqual({ ok: false, code: 'NOT_CONNECTED' });
    store(settings);
    expect(settings.saveSettings({ enabled: false })).toEqual({ ok: true });
    expect(open().publicState().enabled).toBe(false);
    expect(settings.saveSettings({ enabled: true })).toEqual({ ok: true });
    expect(open().publicState().enabled).toBe(true);
  });

  it('a key from an earlier 0.3.0 build (never tested) cannot enable AI until it is verified', () => {
    temp.writeJson(FILE_NAME, { version: 1, enabled: true, provider: 'anthropic', model: 'claude-haiku-5-5', credentials: { anthropic: encrypted() } });
    const settings = open();
    // Its old "model" field is ignored without a repair; the enabled flag is repaired.
    expect(settings.publicState()).toMatchObject({ key: 'stored', verifiedAt: null, enabled: false, status: 'repaired' });
    expect(settings.saveSettings({ enabled: true })).toEqual({ ok: false, code: 'NOT_CONNECTED' });
    expect(settings.markVerified(VERIFIED_AT)).toEqual({ ok: true });
    expect(settings.saveSettings({ enabled: true })).toEqual({ ok: true });
    expect(JSON.parse(fileText())).not.toHaveProperty('model');
  });

  it('a failed write keeps the previous key and settings and reports the error code only', () => {
    const settings = open();
    store(settings);
    const renameSync = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    try {
      expect(settings.saveSettings({ enabled: false })).toEqual({ ok: false, code: 'EPERM' });
      expect(store(settings, OTHER_TEST_KEY, '2026-10-25T09:00:00.000Z')).toEqual({ ok: false, code: 'EPERM' });
      expect(settings.clearApiKey()).toEqual({ ok: false, code: 'EPERM' });
    } finally {
      renameSync.mockRestore();
    }
    expect(settings.publicState()).toMatchObject({ enabled: true, key: 'stored', verifiedAt: VERIFIED_AT });
    expect(settings.getApiKey()).toBe(TEST_KEY);
    expect(temp.list()).toEqual([FILE_NAME]);
  });
});

describe('missing, corrupt and unsupported files', () => {
  it('a corrupt file falls back to defaults (AI off) and is preserved as a copy', () => {
    temp.writeText(FILE_NAME, '{ "enabled": true, broken');
    const settings = open();
    expect(settings.publicState()).toMatchObject({ enabled: false, status: 'repaired', key: 'none' });
    expect(fs.readFileSync(temp.file(copies('unreadable')[0]), 'utf8')).toBe('{ "enabled": true, broken');
  });

  it('invalid fields are repaired one by one, keeping what is valid', () => {
    temp.writeJson(FILE_NAME, { version: 1, enabled: 'yes', provider: 'anthropic', verifiedAt: 'not a date', credentials: { anthropic: encrypted(), evil: 'x', other: 42 }, extra: true });
    const settings = open();
    expect(settings.publicState()).toMatchObject({ enabled: false, key: 'stored', verifiedAt: null, status: 'repaired' });
    expect(settings.getApiKey()).toBe(TEST_KEY);
    expect(copies('before-repair')).toHaveLength(1);
  });

  it('an unknown provider falls back to the default provider', () => {
    temp.writeJson(FILE_NAME, { version: 1, enabled: false, provider: 'mystery', verifiedAt: null, credentials: {} });
    const settings = open();
    expect(settings.publicState().status).toBe('repaired');
    expect(settings.getProviderId()).toBe('anthropic');
  });

  it('settings from a newer version are never overwritten', () => {
    const newer = JSON.stringify({ version: 9, enabled: true, provider: 'future', credentials: {} });
    temp.writeText(FILE_NAME, newer);
    const settings = open();
    expect(settings.publicState()).toMatchObject({ status: 'newer-version', writable: false, enabled: false });
    expect(settings.saveSettings({ enabled: false })).toEqual({ ok: false, code: 'READ_ONLY' });
    expect(settings.canStoreKey()).toEqual({ ok: false, code: 'READ_ONLY' });
    expect(store(settings)).toEqual({ ok: false, code: 'READ_ONLY' });
    expect(fileText()).toBe(newer);
  });

  it('an oversized file is treated as corrupt (and kept)', () => {
    temp.writeText(FILE_NAME, `{"pad":"${'x'.repeat(70 * 1024)}"}`);
    expect(open().publicState().status).toBe('repaired');
    expect(copies('unreadable')).toHaveLength(1);
  });

  it('never touches the task data file', () => {
    temp.writeText('taskflow-data.json', '{"schemaVersion":3}');
    const settings = open();
    store(settings);
    settings.saveSettings({ enabled: false });
    expect(fs.readFileSync(temp.file('taskflow-data.json'), 'utf8')).toBe('{"schemaVersion":3}');
    expect(temp.list()).toEqual([FILE_NAME, 'taskflow-data.json']);
  });
});
