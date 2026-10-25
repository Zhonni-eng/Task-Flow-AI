// Renderer access to AI settings through the restricted preload API (window.taskflow.ai).
// The API key goes one way only: it can be sent to be tested and stored, never read back.
// Every call resolves to { ok, state?, code? } and never throws.

const bridge = () => (typeof window !== 'undefined' ? window.taskflow?.ai : undefined);

async function call(method, ...args) {
  const api = bridge();
  if (!api) return { ok: false, code: 'UNAVAILABLE' };
  try {
    const result = await api[method](...args);
    if (!result || typeof result.ok !== 'boolean') return { ok: false, code: 'NO_RESULT' };
    return result;
  } catch {
    return { ok: false, code: 'IPC_FAILED' };
  }
}

export const getAiSettings = () => call('getSettings');
/** `changes`: { enabled } */
export const saveAiSettings = (changes) => call('saveSettings', changes);
/**
 * Tests `key` and stores it only if the test succeeds; without a key, tests the stored one again.
 * `service` (advanced settings): { provider: 'auto' | provider id, baseUrl?, model? }.
 */
export const connectAi = (key, service = { provider: 'auto' }) => {
  if (key === undefined) return call('connect');
  const request = { key, provider: service.provider ?? 'auto' };
  if (service.provider === 'openai-compatible') Object.assign(request, { baseUrl: service.baseUrl ?? '', model: service.model ?? '' });
  // Any other service: an optional model id (empty = the service's default model).
  else if (service.model?.trim()) request.model = service.model.trim();
  return call('connect', request);
};
/** Removes the stored key and switches the assistant off. */
export const disconnectAi = () => call('disconnect');

/** Voice input: { audio: Uint8Array, mimeType } -> { ok, text } or { ok: false, code }. */
export const transcribeAudio = (request) => call('transcribe', request);
/** Saves an OpenAI key for voice input only (checked first; the assistant's service is unchanged). */
export const connectSpeechKey = (key) => call('connectSpeech', { key });
