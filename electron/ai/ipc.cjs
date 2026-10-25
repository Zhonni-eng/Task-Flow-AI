// IPC handlers for AI settings (main process). Every handler checks the sender (only the app's
// own page) and validates the payload before the settings store sees it. Results are plain data:
// { ok, state } or { ok: false, code, state } - never a key, never an exception message.
const { MAX_KEY_LENGTH } = require('./aiSettings.cjs');
const { PROVIDER_IDS } = require('./providers.cjs');
const { MAX_MESSAGE_LENGTH } = require('./chatService.cjs');

const CHANNELS = Object.freeze({
  getSettings: 'ai:get-settings',
  saveSettings: 'ai:save-settings',
  connect: 'ai:connect',
  disconnect: 'ai:disconnect',
  chat: 'ai:chat',
  resetChat: 'ai:reset-chat',
  transcribe: 'ai:transcribe',
  connectSpeech: 'ai:connect-speech',
});

const SETTINGS_FIELDS = ['enabled'];
const MAX_RECENT_IDS = 50;
const MAX_ID_LENGTH_TASK = 100;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** { changes } or { code } for a renderer-supplied settings update. */
function validateSettingsPayload(payload) {
  if (!isPlainObject(payload)) return { code: 'INVALID_INPUT' };
  const keys = Object.keys(payload);
  if (keys.length === 0 || keys.some((key) => !SETTINGS_FIELDS.includes(key))) return { code: 'INVALID_INPUT' };
  if (typeof payload.enabled !== 'boolean') return { code: 'INVALID_INPUT' };
  return { changes: { enabled: payload.enabled } };
}

const CONNECT_FIELDS = ['key', 'provider', 'baseUrl', 'model'];
const MAX_CONFIG_LENGTH = 300;

/**
 * { request } for the connection - { key, provider, baseUrl?, model? } for a new key, or {} to
 * re-test the stored one - or { code }. Values are checked again (normalized) by the connection.
 */
function validateConnectPayload(payload) {
  if (payload === undefined || payload === null) return { request: {} };
  if (!isPlainObject(payload)) return { code: 'INVALID_INPUT' };
  const keys = Object.keys(payload);
  if (!keys.includes('key') || keys.some((key) => !CONNECT_FIELDS.includes(key))) return { code: 'INVALID_INPUT' };
  if (typeof payload.key !== 'string' || payload.key.trim().length === 0 || payload.key.length > MAX_KEY_LENGTH) return { code: 'INVALID_KEY' };
  const provider = payload.provider ?? 'auto';
  if (provider !== 'auto' && !PROVIDER_IDS.includes(provider)) return { code: 'INVALID_INPUT' };
  for (const field of ['baseUrl', 'model']) {
    if (field in payload && (typeof payload[field] !== 'string' || payload[field].length > MAX_CONFIG_LENGTH)) return { code: 'INVALID_INPUT' };
  }
  return { request: { key: payload.key, provider, baseUrl: payload.baseUrl, model: payload.model } };
}

/** { message, language } or { code } for a chat request from the renderer. */
function validateChatPayload(payload) {
  if (!isPlainObject(payload)) return { code: 'INVALID_INPUT' };
  const keys = Object.keys(payload);
  if (keys.some((key) => !['message', 'language', 'recentTaskIds'].includes(key)) || !('message' in payload)) return { code: 'INVALID_INPUT' };
  if (typeof payload.message !== 'string' || payload.message.length > MAX_MESSAGE_LENGTH || !payload.message.trim()) return { code: 'INVALID_MESSAGE' };
  if ('language' in payload && payload.language !== 'ru' && payload.language !== 'en') return { code: 'INVALID_INPUT' };
  if ('recentTaskIds' in payload) {
    const ids = payload.recentTaskIds;
    if (!Array.isArray(ids) || ids.length > MAX_RECENT_IDS || ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH_TASK)) {
      return { code: 'INVALID_INPUT' };
    }
  }
  return { message: payload.message, language: payload.language ?? 'ru', recentTaskIds: payload.recentTaskIds ?? [] };
}

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** { audio: Uint8Array, mimeType } or { code } for a recording sent for transcription. */
function validateTranscribePayload(payload) {
  if (!isPlainObject(payload)) return { code: 'INVALID_INPUT' };
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !keys.includes('audio') || !keys.includes('mimeType')) return { code: 'INVALID_INPUT' };
  if (typeof payload.mimeType !== 'string' || payload.mimeType.length > 100) return { code: 'INVALID_INPUT' };
  const { audio } = payload;
  // Byte views and ArrayBuffers from IPC may come from another realm: test by kind, not instanceof.
  let bytes = null;
  if (ArrayBuffer.isView(audio) && audio.BYTES_PER_ELEMENT === 1) bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  else if (Object.prototype.toString.call(audio) === '[object ArrayBuffer]') bytes = new Uint8Array(audio);
  if (!bytes) return { code: 'INVALID_INPUT' };
  if (bytes.byteLength > MAX_AUDIO_BYTES) return { code: 'RECORDING_TOO_LONG' };
  return { audio: bytes, mimeType: payload.mimeType };
}

/** Usage figures for the renderer: numbers only (tokens, estimated cost) and the model id. */
function cleanUsage(usage) {
  if (!usage) return null;
  const count = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);
  return {
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    costUsd: Number.isFinite(usage.costUsd) ? usage.costUsd : null,
    model: typeof usage.model === 'string' ? usage.model.slice(0, 200) : null,
  };
}

/**
 * Registers the AI handlers. `isTrustedSender(event)` is the same check the storage handlers use.
 * Returns the handler functions for tests.
 */
function registerAiHandlers({ ipcMain, settings, connection, chat, speech, isTrustedSender }) {
  const state = () => connection.publicState();
  const respond = (result) => (result.ok ? { ok: true, state: state() } : { ok: false, code: result.code, state: state() });
  const guard = (handler) => (event, ...args) => {
    if (!isTrustedSender(event)) return { ok: false, code: 'FORBIDDEN' };
    // Never forward exception text: it could echo renderer input or provider data.
    const internal = () => ({ ok: false, code: 'INTERNAL' });
    try {
      const result = handler(...args);
      return result && typeof result.then === 'function' ? result.catch(internal) : result;
    } catch {
      return internal();
    }
  };

  const handlers = {
    [CHANNELS.getSettings]: guard(() => ({ ok: true, state: state() })),
    [CHANNELS.saveSettings]: guard((payload) => {
      const checked = validateSettingsPayload(payload);
      if (checked.code) return respond({ ok: false, code: checked.code });
      return respond(settings.saveSettings(checked.changes));
    }),
    // Tests the key with its provider and stores it only if that worked.
    [CHANNELS.connect]: guard(async (payload) => {
      const checked = validateConnectPayload(payload);
      if (checked.code) return respond({ ok: false, code: checked.code });
      return respond(await connection.connect(checked.request));
    }),
    [CHANNELS.disconnect]: guard(() => respond(connection.disconnect())),
    // Chat results carry the provider's proposal as plain data; the renderer validates it again
    // and the user confirms before anything is created. History and keys never leave main.
    [CHANNELS.chat]: guard(async (payload) => {
      const checked = validateChatPayload(payload);
      if (checked.code) return { ok: false, code: checked.code };
      if (!chat) return { ok: false, code: 'UNAVAILABLE' };
      const result = await chat.send(checked.message, checked.language, checked.recentTaskIds);
      return result.ok
        ? { ok: true, plan: result.plan, sharedTaskIds: result.sharedTaskIds ?? [], usage: cleanUsage(result.usage) }
        : { ok: false, code: result.code };
    }),
    // Voice input: the recognized text only goes back to the message box; nothing is sent on.
    [CHANNELS.transcribe]: guard(async (payload) => {
      const checked = validateTranscribePayload(payload);
      if (checked.code) return { ok: false, code: checked.code };
      if (!speech) return { ok: false, code: 'UNAVAILABLE' };
      const result = await speech.transcribe(checked.audio, checked.mimeType);
      return result.ok ? { ok: true, text: result.text } : { ok: false, code: result.code };
    }),
    // Saves an OpenAI key for voice input after checking it; the assistant's service is unchanged.
    [CHANNELS.connectSpeech]: guard(async (payload) => {
      if (!isPlainObject(payload) || Object.keys(payload).join() !== 'key') return respond({ ok: false, code: 'INVALID_INPUT' });
      if (typeof payload.key !== 'string' || !payload.key.trim() || payload.key.length > MAX_KEY_LENGTH) return respond({ ok: false, code: 'INVALID_KEY' });
      if (!speech) return respond({ ok: false, code: 'UNAVAILABLE' });
      return respond(await speech.connectKey(payload.key));
    }),
    [CHANNELS.resetChat]: guard(() => {
      chat?.reset();
      return { ok: true };
    }),
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
  return handlers;
}

module.exports = { registerAiHandlers, validateSettingsPayload, validateConnectPayload, validateChatPayload, validateTranscribePayload, CHANNELS };
