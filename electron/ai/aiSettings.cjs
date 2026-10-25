// AI settings and API keys (main process only). Stored in their own file, separate from the
// task data, so the task-data schema is untouched:
//
//   taskflow-ai.json = {
//     version: 1,
//     enabled: boolean,                 // off by default
//     provider: '<provider id>',        // the active connection's provider
//     verifiedAt: '<ISO time>' | null,  // when the active key last passed a connection test
//     credentials: { '<provider id>': '<base64 of safeStorage-encrypted key>' },  // one per provider
//     compatible: { baseUrl, model } | null  // OpenAI-compatible API (advanced settings)
//     models: { '<provider id>': '<model id>' }  // model chosen in the advanced settings (verified)
//   }
//
// A key is stored only after it passed a connection test (see connection.cjs), and AI can only be
// enabled with such a key. Each key is stored under its own provider and is only ever given to
// that provider's adapter. Files of earlier 0.3.0 builds may still hold a "model" field; it is
// ignored (each provider uses one fixed model) and dropped on the next save.
//
// API keys are only ever stored encrypted with Electron safeStorage (DPAPI on Windows). If
// secure storage is unavailable, saving a key is refused - there is no plaintext fallback.
// Keys never leave this module except through getApiKey() for main-process provider calls,
// and never appear in returned states, error codes or logs.
const fs = require('node:fs');
const path = require('node:path');
const { CONFIGURABLE_PROVIDER, DEFAULT_PROVIDER, getProvider, normalizeBaseUrl, normalizeModelId } = require('./providers.cjs');

const FILE_NAME = 'taskflow-ai.json';
const VERSION = 1;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_KEY_LENGTH = 512;
const MAX_ENCRYPTED_LENGTH = 8192;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const FILE_KEYS = ['version', 'enabled', 'provider', 'verifiedAt', 'credentials', 'compatible', 'models'];
const LEGACY_KEYS = ['model'];
const MAX_TIME_LENGTH = 40;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function defaults() {
  return { version: VERSION, enabled: false, provider: DEFAULT_PROVIDER, verifiedAt: null, credentials: {}, compatible: null, models: {} };
}

/** Electron safeStorage is usable only with real OS encryption (not Linux's plaintext backend). */
function secureStorageAvailable(safeStorage) {
  try {
    if (!safeStorage?.isEncryptionAvailable?.()) return false;
    if (typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  } catch {
    return false;
  }
}

/** Cleans a parsed settings object. `changed` is true when anything had to be fixed. */
function sanitize(raw) {
  const clean = defaults();
  let changed = !isPlainObject(raw) || Object.keys(raw).some((key) => !FILE_KEYS.includes(key) && !LEGACY_KEYS.includes(key));
  if (!isPlainObject(raw)) return { settings: clean, changed };

  if (typeof raw.enabled === 'boolean') clean.enabled = raw.enabled;
  else changed = true;

  if (getProvider(raw.provider)) clean.provider = raw.provider;
  else changed = true;
  // Missing in files of earlier 0.3.0 builds: their keys were never tested, so they count as unverified.
  if (raw.verifiedAt === undefined || raw.verifiedAt === null) clean.verifiedAt = null;
  else if (typeof raw.verifiedAt === 'string' && raw.verifiedAt.length <= MAX_TIME_LENGTH && !Number.isNaN(Date.parse(raw.verifiedAt))) clean.verifiedAt = raw.verifiedAt;
  else changed = true;

  if (isPlainObject(raw.credentials)) {
    for (const [providerId, value] of Object.entries(raw.credentials)) {
      if (getProvider(providerId) && typeof value === 'string' && value.length <= MAX_ENCRYPTED_LENGTH && BASE64.test(value)) {
        clean.credentials[providerId] = value;
      } else {
        changed = true;
      }
    }
  } else if (raw.credentials !== undefined) {
    changed = true;
  }

  if (raw.compatible !== undefined && raw.compatible !== null) {
    const baseUrl = normalizeBaseUrl(raw.compatible?.baseUrl);
    const model = normalizeModelId(raw.compatible?.model);
    if (baseUrl && model) clean.compatible = { baseUrl, model };
    else changed = true;
  }
  if (isPlainObject(raw.models)) {
    for (const [providerId, model] of Object.entries(raw.models)) {
      const id = normalizeModelId(model);
      if (getProvider(providerId) && providerId !== CONFIGURABLE_PROVIDER && id) clean.models[providerId] = id;
      else changed = true;
    }
  } else if (raw.models !== undefined) {
    changed = true;
  }
  // The OpenAI-compatible provider cannot be active without its configuration.
  if (clean.provider === CONFIGURABLE_PROVIDER && !clean.compatible) {
    clean.provider = DEFAULT_PROVIDER;
    clean.verifiedAt = null;
    changed = true;
  }
  return { settings: clean, changed };
}

function createAiSettings({ dir, safeStorage, fileName = FILE_NAME }) {
  const file = path.join(dir, fileName);
  const tempFile = `${file}.tmp`;
  let settings = null;
  let status = null; // 'new' | 'loaded' | 'repaired' | 'newer-version' | 'read-error'
  let writable = true;

  const secure = () => secureStorageAvailable(safeStorage);

  function preserveCopy(reason) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(file, path.join(dir, `taskflow-ai.${reason}-${stamp}.json`));
    } catch {
      // A copy is best effort; the original file is not deleted either way.
    }
  }

  function load() {
    if (settings) return;
    if (!fs.existsSync(file)) {
      settings = defaults();
      status = 'new';
      return;
    }
    let raw;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) throw Object.assign(new Error('too large'), { code: 'INVALID' });
      raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch (error) {
      if (error.code && error.code !== 'INVALID') {
        // I/O problem (locked, permissions): the file may be fine, so never overwrite it.
        settings = defaults();
        status = 'read-error';
        writable = false;
        return;
      }
      preserveCopy('unreadable');
      settings = defaults();
      status = 'repaired';
      return;
    }
    if (isPlainObject(raw) && Number.isInteger(raw.version) && raw.version > VERSION) {
      // Written by a newer Taskflow: use defaults and never overwrite it.
      settings = defaults();
      status = 'newer-version';
      writable = false;
      return;
    }
    const result = sanitize(raw);
    settings = result.settings;
    status = result.changed ? 'repaired' : 'loaded';
    if (result.changed) preserveCopy('before-repair');
    // AI can only stay enabled with a usable key that passed a connection test.
    if (settings.enabled && !(keyState() === 'stored' && settings.verifiedAt)) {
      settings.enabled = false;
      status = 'repaired';
    }
  }

  function write(next) {
    const json = JSON.stringify(next, null, 2);
    const fd = fs.openSync(tempFile, 'w');
    try {
      fs.writeSync(fd, json, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempFile, file);
  }

  /** Applies `next` atomically; on failure the previous settings stay in effect. */
  function commit(next) {
    if (!writable) return { ok: false, code: 'READ_ONLY' };
    try {
      fs.mkdirSync(dir, { recursive: true });
      write(next);
      settings = next;
      if (status === 'new' || status === 'repaired') status = 'loaded';
      return { ok: true };
    } catch (error) {
      try {
        fs.rmSync(tempFile, { force: true });
      } catch {
        // ignore cleanup failure
      }
      return { ok: false, code: typeof error.code === 'string' ? error.code : 'WRITE_FAILED' };
    }
  }

  /** 'none' | 'stored' | 'unreadable' (stored but cannot be decrypted here, e.g. another Windows user). */
  function keyState(providerId = settings.provider) {
    const stored = settings.credentials[providerId];
    if (!stored) return 'none';
    if (!secure()) return 'unreadable';
    try {
      const key = safeStorage.decryptString(Buffer.from(stored, 'base64'));
      return typeof key === 'string' && key.length > 0 ? 'stored' : 'unreadable';
    } catch {
      return 'unreadable';
    }
  }

  /**
   * Everything the renderer may know. Never contains a key or any part of one, nor the provider:
   * the interface does not deal with providers. `verifiedAt` is when the key last passed a
   * connection test - not a claim that it works right now.
   */
  function publicState() {
    load();
    const key = keyState();
    return {
      enabled: settings.enabled,
      key,
      verifiedAt: key === 'none' ? null : settings.verifiedAt,
      secureStorage: secure() ? 'available' : 'unavailable',
      status,
      writable,
      // Voice input works when an OpenAI key is stored (the chat's or one saved for voice input).
      speech: { available: keyState('openai') === 'stored' },
      // For the advanced settings only: which service the stored key belongs to (an id, never a
      // key) and the OpenAI-compatible configuration (not secret).
      advanced: {
        provider: key === 'none' ? null : settings.provider,
        model: key === 'none' ? null : getTarget().model,
        compatible: settings.compatible ? { ...settings.compatible } : null,
      },
    };
  }

  /** Partial update of { enabled? }. Inputs must already be type-checked. */
  function saveSettings(changes) {
    load();
    const next = { ...settings, credentials: { ...settings.credentials } };
    if ('enabled' in changes) next.enabled = changes.enabled === true;
    if (next.enabled && !(keyState() === 'stored' && settings.verifiedAt)) return { ok: false, code: 'NOT_CONNECTED' };
    return commit(next);
  }

  /** Whether a new key could be stored at all - checked before any connection test is made. */
  function canStoreKey() {
    load();
    if (!writable) return { ok: false, code: 'READ_ONLY' };
    if (!secure()) return { ok: false, code: 'SECURE_STORAGE_UNAVAILABLE' };
    return { ok: true };
  }

  /**
   * Stores a key that just passed a connection test, replacing any previous key, and switches AI
   * on. Atomic: on any failure the previous key and settings stay exactly as they were.
   */
  function storeVerifiedKey(providerId, rawKey, verifiedAt, config = null) {
    load();
    const provider = getProvider(providerId);
    if (!provider) return { ok: false, code: 'UNSUPPORTED_KEY' };
    let compatible = settings.compatible;
    const models = { ...settings.models };
    if (provider.id !== CONFIGURABLE_PROVIDER) {
      // A model other than the provider's default is remembered (it passed the connection test).
      const model = config?.model ? normalizeModelId(config.model) : null;
      if (config?.model && !model) return { ok: false, code: 'INVALID_MODEL' };
      if (model && model !== provider.model) models[provider.id] = model;
      else delete models[provider.id];
    }
    if (provider.id === CONFIGURABLE_PROVIDER) {
      const baseUrl = normalizeBaseUrl(config?.baseUrl);
      const model = normalizeModelId(config?.model);
      if (!baseUrl) return { ok: false, code: 'INVALID_BASE_URL' };
      if (!model) return { ok: false, code: 'INVALID_MODEL' };
      compatible = { baseUrl, model };
    }
    if (typeof rawKey !== 'string' || rawKey.length > MAX_KEY_LENGTH) return { ok: false, code: 'INVALID_KEY' };
    const key = rawKey.trim();
    if (!key || !provider.isApiKeyFormat(key)) return { ok: false, code: 'INVALID_KEY' };
    const allowed = canStoreKey();
    if (!allowed.ok) return allowed;
    let encrypted;
    try {
      encrypted = safeStorage.encryptString(key);
      // Never store something that cannot be read back.
      if (safeStorage.decryptString(encrypted) !== key) return { ok: false, code: 'ENCRYPTION_FAILED' };
    } catch {
      return { ok: false, code: 'ENCRYPTION_FAILED' };
    }
    // Stored under its own provider; keys of other providers stay as they are.
    return commit({
      ...settings,
      enabled: true,
      provider: provider.id,
      verifiedAt,
      credentials: { ...settings.credentials, [provider.id]: Buffer.from(encrypted).toString('base64') },
      compatible,
      models,
    });
  }

  /** Records that the stored key passed a connection test again. */
  function markVerified(verifiedAt) {
    load();
    if (keyState() !== 'stored') return { ok: false, code: 'NO_KEY' };
    return commit({ ...settings, verifiedAt });
  }

  /** Removes every stored key and the OpenAI-compatible configuration; AI is switched off. */
  function clearApiKey() {
    load();
    return commit({ ...settings, enabled: false, provider: DEFAULT_PROVIDER, verifiedAt: null, credentials: {}, compatible: null, models: {} });
  }

  /** Main process only: the provider id of the active connection. */
  function getProviderId() {
    load();
    return settings.provider;
  }

  /** Main process only: where requests of the active connection go - { providerId, model, baseUrl }. */
  function getTarget() {
    load();
    const provider = getProvider(settings.provider);
    if (provider.id === CONFIGURABLE_PROVIDER) return { providerId: provider.id, model: settings.compatible?.model ?? null, baseUrl: settings.compatible?.baseUrl ?? null };
    return { providerId: provider.id, model: settings.models[provider.id] ?? provider.model, baseUrl: null };
  }

  /** Main process only (provider calls): the decrypted stored key, or null. */
  function getApiKey() {
    load();
    return getProviderKey(settings.provider);
  }

  /** Main process only: the decrypted stored key of one provider (e.g. OpenAI for voice input), or null. */
  function getProviderKey(providerId) {
    load();
    const stored = settings.credentials[providerId];
    if (!stored || !secure()) return null;
    try {
      const key = safeStorage.decryptString(Buffer.from(stored, 'base64'));
      return typeof key === 'string' && key ? key : null;
    } catch {
      return null;
    }
  }

  /**
   * Stores a verified key for one provider WITHOUT changing the assistant's connection (voice
   * input uses OpenAI whatever service the assistant uses). Encrypted like every key.
   */
  function storeProviderKey(providerId, rawKey) {
    load();
    const provider = getProvider(providerId);
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!provider || !key || key.length > MAX_KEY_LENGTH || !provider.isApiKeyFormat(key)) return { ok: false, code: 'INVALID_KEY' };
    const allowed = canStoreKey();
    if (!allowed.ok) return allowed;
    let encrypted;
    try {
      encrypted = safeStorage.encryptString(key);
      if (safeStorage.decryptString(encrypted) !== key) return { ok: false, code: 'ENCRYPTION_FAILED' };
    } catch {
      return { ok: false, code: 'ENCRYPTION_FAILED' };
    }
    return commit({ ...settings, credentials: { ...settings.credentials, [provider.id]: Buffer.from(encrypted).toString('base64') } });
  }

  return {
    publicState, saveSettings, canStoreKey, storeVerifiedKey, storeProviderKey, markVerified, clearApiKey,
    getApiKey, getProviderKey, getProviderId, getTarget, file,
  };
}

module.exports = { createAiSettings, FILE_NAME, MAX_KEY_LENGTH, secureStorageAvailable };
