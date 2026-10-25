// AI connection (main process): tests a key against its provider before it is stored, and keeps
// the connection status of the current app session in memory.
//
// - A new key goes to exactly one provider: the one its shape suggests, or the one chosen in the
//   advanced settings (providers.cjs). It is tested with one minimal request of that provider (no
//   task data) and stored encrypted only if the test succeeded. A failed test never replaces the
//   previously working configuration.
// - A stored key is not assumed to work: after a restart the status is "saved" (it passed a test
//   at `verifiedAt`) until a test or a chat request succeeds again in this session.
// - Keys never leave the main process; results carry codes only, never provider messages.
const { CONFIGURABLE_PROVIDER, detectProvider, getProvider, normalizeBaseUrl, normalizeModelId } = require('./providers.cjs');

// Connection test failures that mean the stored key itself is not usable right now.
const KEY_FAILURES = new Set(['AUTH', 'PERMISSION', 'MODEL_UNAVAILABLE']);

function createConnection({ settings, adapterDeps = {}, now = () => new Date() }) {
  const adapters = new Map();
  // 'connected' after a successful test or request in this session; 'failed' after the stored key
  // was rejected; null when nothing is known yet for this session.
  let session = null;
  let busy = false;

  const adapterFor = (provider) => {
    if (!adapters.has(provider.id)) adapters.set(provider.id, provider.createAdapter(adapterDeps));
    return adapters.get(provider.id);
  };

  /**
   * The renderer's view: the stored settings plus `connection`:
   *   'none'       no key stored
   *   'connected'  the key worked in this session
   *   'saved'      a key that passed a test earlier is stored; not checked in this session yet
   *   'unverified' a stored key that never passed a test (earlier 0.3.0 builds)
   *   'failed'     the stored key was rejected in this session
   *   'unreadable' a key is stored but cannot be decrypted here
   */
  function publicState() {
    const state = settings.publicState();
    let connection;
    if (state.key === 'none') connection = 'none';
    else if (state.key === 'unreadable') connection = 'unreadable';
    else if (session) connection = session;
    else connection = state.verifiedAt ? 'saved' : 'unverified';
    return { ...state, connection };
  }

  async function test(provider, apiKey, target) {
    try {
      const result = await adapterFor(provider).testConnection({ apiKey, model: target.model, baseUrl: target.baseUrl });
      return result?.ok ? { ok: true } : { ok: false, code: result?.code ?? 'PROVIDER_ERROR' };
    } catch {
      return { ok: false, code: 'PROVIDER_ERROR' };
    }
  }

  /**
   * `request`: { key, provider?, baseUrl?, model? } to test and store a new key - `provider` is
   * 'auto' (suggested by the key's shape) or a provider id chosen in the advanced settings; for the
   * OpenAI-compatible provider `baseUrl` and `model` are required. Without a key, the stored key
   * is tested again. Exactly one provider ever receives the key.
   * Returns { ok: true } or { ok: false, code }.
   */
  async function connect(request = {}) {
    if (busy) return { ok: false, code: 'BUSY' };
    busy = true;
    try {
      if (request.key === undefined) {
        const target = settings.getTarget();
        const provider = getProvider(target.providerId);
        const apiKey = settings.publicState().key === 'stored' ? settings.getApiKey() : null;
        if (!provider || !apiKey || !target.model) return { ok: false, code: 'NO_KEY' };
        const result = await test(provider, apiKey, target);
        if (!result.ok) {
          if (KEY_FAILURES.has(result.code)) session = 'failed';
          return result;
        }
        const saved = settings.markVerified(now().toISOString());
        session = 'connected';
        // The key works either way; a failed timestamp write is reported but changes nothing else.
        return saved.ok ? { ok: true } : { ok: false, code: saved.code };
      }

      const key = typeof request.key === 'string' ? request.key.trim() : '';
      const choice = request.provider ?? 'auto';
      let provider;
      if (choice === 'auto') {
        const detected = detectProvider(key);
        if (detected.code) return { ok: false, code: detected.code };
        provider = detected.provider;
      } else {
        provider = getProvider(choice);
        if (!provider) return { ok: false, code: 'UNSUPPORTED_KEY' };
        if (!provider.isApiKeyFormat(key)) return { ok: false, code: 'INVALID_KEY' };
      }
      let target = { model: provider.model, baseUrl: null };
      if (provider.id !== CONFIGURABLE_PROVIDER && typeof request.model === 'string' && request.model.trim()) {
        // A model chosen in the advanced settings: tested with exactly this id, never replaced.
        const model = normalizeModelId(request.model);
        if (!model) return { ok: false, code: 'INVALID_MODEL' };
        target = { model, baseUrl: null };
      }
      if (provider.id === CONFIGURABLE_PROVIDER) {
        const baseUrl = normalizeBaseUrl(request.baseUrl);
        if (!baseUrl) return { ok: false, code: 'INVALID_BASE_URL' };
        const model = normalizeModelId(request.model);
        if (!model) return { ok: false, code: 'INVALID_MODEL' };
        target = { model, baseUrl };
      }
      // Do not test a key that could not be stored afterwards.
      const storable = settings.canStoreKey();
      if (!storable.ok) return storable;
      const result = await test(provider, key, target);
      // The previous configuration (if any) and its status stay exactly as they were.
      if (!result.ok) return result;
      const stored = settings.storeVerifiedKey(provider.id, key, now().toISOString(), target);
      if (!stored.ok) return stored;
      session = 'connected';
      return { ok: true };
    } finally {
      busy = false;
    }
  }

  function disconnect() {
    const result = settings.clearApiKey();
    if (result.ok) session = null;
    return result;
  }

  /** Chat requests report their outcome here, so the status reflects what actually happened. */
  function noteRequest(result) {
    if (result?.ok) session = 'connected';
    else if (result?.code === 'AUTH' || result?.code === 'PERMISSION') session = 'failed';
  }

  return { publicState, connect, disconnect, noteRequest, isBusy: () => busy };
}

module.exports = { createConnection };
