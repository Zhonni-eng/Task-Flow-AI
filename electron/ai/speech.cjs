// Voice input (main process): speech-to-text with the OpenAI Audio API. The window records audio
// and sends it here; the text comes back and is only inserted into the message box - nothing is
// sent to the assistant or applied automatically.
//
// The OpenAI key is the one stored for OpenAI (encrypted, see aiSettings.cjs): the chat
// connection's key when the assistant uses OpenAI, or a key saved for voice input only - which
// does not change the assistant's service.
//
// Model: gpt-4o-mini-transcribe, as requested. OpenAI lists it as deprecated, shutting down on
// 2027-02-26 (recommended successor: gpt-transcribe) - change TRANSCRIBE_MODEL to switch.
// Request (OpenAI API reference, checked 2026-10-25): POST /v1/audio/transcriptions,
// multipart/form-data with `file` and `model`; files up to 25 MB; webm is a supported format. The
// language is detected from the speech (Russian or English).
const { isPlainObject, requestJson } = require('./providers/shared.cjs');
const { getProvider } = require('./providers.cjs');

const API_BASE_URL = 'https://api.openai.com/v1';
const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 15_000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // well under the API's 25 MB; ~10 min of Opus audio
const MIN_AUDIO_BYTES = 1000; // a click without speech
const MAX_TEXT = 2000; // the message box limit
// Formats the window may record in (MediaRecorder) and the API accepts.
const AUDIO_TYPES = Object.freeze({ 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3' });

const authHeaders = (apiKey) => ({ authorization: `Bearer ${apiKey}` });

function createSpeechService({ settings, fetch = (...args) => globalThis.fetch(...args) }) {
  let busy = false;

  /** Checks a key for voice input (one GET of the model, no audio) and stores it for OpenAI. */
  async function connectKey(rawKey) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!getProvider('openai').isApiKeyFormat(key)) return { ok: false, code: 'INVALID_KEY' };
    const storable = settings.canStoreKey();
    if (!storable.ok) return storable;
    const result = await requestJson({ fetch, url: `${API_BASE_URL}/models/${TRANSCRIBE_MODEL}`, headers: authHeaders(key), timeoutMs: TEST_TIMEOUT_MS });
    if (!result.ok) return result;
    if (!isPlainObject(result.json) || result.json.object !== 'model') return { ok: false, code: 'MALFORMED' };
    return settings.storeProviderKey('openai', key);
  }

  /**
   * `audio`: Uint8Array of the recording; `mimeType`: its type (codec parameters ignored).
   * Returns { ok: true, text } or { ok: false, code }.
   */
  async function transcribe(audio, mimeType) {
    const type = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
    const extension = AUDIO_TYPES[type];
    if (!extension) return { ok: false, code: 'UNSUPPORTED_AUDIO' };
    if (!(audio instanceof Uint8Array) || audio.byteLength < MIN_AUDIO_BYTES) return { ok: false, code: 'EMPTY_RECORDING' };
    if (audio.byteLength > MAX_AUDIO_BYTES) return { ok: false, code: 'RECORDING_TOO_LONG' };
    const apiKey = settings.getProviderKey('openai');
    if (!apiKey) return { ok: false, code: 'NO_SPEECH_KEY' };
    if (busy) return { ok: false, code: 'BUSY' };
    busy = true;
    try {
      const form = new FormData();
      form.append('file', new Blob([audio], { type }), `speech.${extension}`);
      form.append('model', TRANSCRIBE_MODEL);
      const result = await requestJson({ fetch, url: `${API_BASE_URL}/audio/transcriptions`, method: 'POST', headers: authHeaders(apiKey), form, timeoutMs: TRANSCRIBE_TIMEOUT_MS });
      if (!result.ok) return result;
      if (!isPlainObject(result.json) || typeof result.json.text !== 'string') return { ok: false, code: 'MALFORMED' };
      const text = result.json.text.replace(/\s+/g, ' ').trim();
      if (!text) return { ok: false, code: 'EMPTY_TRANSCRIPT' };
      return { ok: true, text: text.slice(0, MAX_TEXT) };
    } catch {
      return { ok: false, code: 'PROVIDER_ERROR' };
    } finally {
      busy = false;
    }
  }

  return { connectKey, transcribe, isBusy: () => busy };
}

module.exports = { createSpeechService, TRANSCRIBE_MODEL, MAX_AUDIO_BYTES, MIN_AUDIO_BYTES, AUDIO_TYPES };
