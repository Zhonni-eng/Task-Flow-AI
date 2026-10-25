// @vitest-environment node
// Voice input in the main process (electron/ai/speech.cjs) and its IPC channels: transcription
// requests to OpenAI (scripted fake fetch - never the network), errors, and the voice input key,
// which is stored for OpenAI without changing the assistant's service.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeFetch, json } from '../helpers/fakeFetch.js';
import { createFakeSafeStorage, TEST_KEY } from '../helpers/fakeSafeStorage.js';
import { createTempDir } from '../helpers/tempDir.js';

const require = createRequire(import.meta.url);
const { createSpeechService, TRANSCRIBE_MODEL } = require('../../electron/ai/speech.cjs');
const { createAiSettings } = require('../../electron/ai/aiSettings.cjs');
const { registerAiHandlers, validateTranscribePayload } = require('../../electron/ai/ipc.cjs');
const { createConnection } = require('../../electron/ai/connection.cjs');

const OPENAI_KEY = 'sk-proj-voice-0123456789abcdefghijklmn';
const audio = (bytes = 4000) => new Uint8Array(bytes).fill(7);
let temp;
beforeEach(() => {
  temp = createTempDir();
});
afterEach(() => temp.remove());

const setup = (http = [], { withKey = true } = {}) => {
  const web = createFakeFetch(http);
  const settings = createAiSettings({ dir: temp.dir, safeStorage: createFakeSafeStorage() });
  if (withKey) settings.storeProviderKey('openai', OPENAI_KEY);
  return { web, settings, speech: createSpeechService({ settings, fetch: web.fetch }) };
};

describe('transcription', () => {
  it('posts the recording as multipart (file + model) to OpenAI with the stored OpenAI key; returns only the text', async () => {
    const { web, speech } = setup([json({ text: '  Перенеси экзамен   на пятницу ', usage: { type: 'tokens', input_tokens: 10, output_tokens: 5 } })]);
    expect(await speech.transcribe(audio(), 'audio/webm;codecs=opus')).toEqual({ ok: true, text: 'Перенеси экзамен на пятницу' });
    const [call] = web.calls;
    expect(call).toMatchObject({ url: 'https://api.openai.com/v1/audio/transcriptions', method: 'POST', redirect: 'error' });
    expect(call.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(call.headers['content-type']).toBeUndefined(); // set by fetch with the multipart boundary
    expect(call.body).toBeInstanceOf(FormData);
    expect(call.body.get('model')).toBe(TRANSCRIBE_MODEL);
    expect(TRANSCRIBE_MODEL).toBe('gpt-4o-mini-transcribe');
    const file = call.body.get('file');
    expect([file.name, file.type, file.size]).toEqual(['speech.webm', 'audio/webm', 4000]);
  });

  it.each([
    ['an empty recording', audio(10), 'audio/webm', 'EMPTY_RECORDING'],
    ['an unsupported format', audio(), 'video/webm', 'UNSUPPORTED_AUDIO'],
    ['an oversized recording', audio(11 * 1024 * 1024), 'audio/webm', 'RECORDING_TOO_LONG'],
  ])('%s is refused without any request', async (_, bytes, type, code) => {
    const { web, speech } = setup();
    expect(await speech.transcribe(bytes, type)).toEqual({ ok: false, code });
    expect(web.calls).toHaveLength(0);
  });

  it('without an OpenAI key nothing is sent', async () => {
    const { web, speech } = setup([], { withKey: false });
    expect(await speech.transcribe(audio(), 'audio/webm')).toEqual({ ok: false, code: 'NO_SPEECH_KEY' });
    expect(web.calls).toHaveLength(0);
  });

  it.each([
    ['a rejected key (401)', json({ error: { message: `bad ${OPENAI_KEY}` } }, 401), 'AUTH'],
    ['a rate limit (429)', json({ error: {} }, 429), 'RATE_LIMIT'],
    ['an outage (500)', json({ error: {} }, 500), 'PROVIDER_ERROR'],
    ['a network failure', new TypeError('fetch failed'), 'NETWORK'],
    ['an unexpected answer', json({ transcript: 'x' }), 'MALFORMED'],
    ['no recognized speech', json({ text: '   ' }), 'EMPTY_TRANSCRIPT'],
  ])('%s -> %s, never with response text', async (_, reply, code) => {
    const { speech } = setup([reply]);
    expect(await speech.transcribe(audio(), 'audio/webm')).toEqual({ ok: false, code });
  });

  it('a stalled request times out', async () => {
    const { requestJson } = require('../../electron/ai/providers/shared.cjs');
    const hang = (call, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const form = new FormData();
    expect(await requestJson({ fetch: createFakeFetch([hang]).fetch, url: 'https://api.openai.com/v1/audio/transcriptions', method: 'POST', form, timeoutMs: 20 })).toEqual({ ok: false, code: 'TIMEOUT' });
  });
});

describe('the voice input key', () => {
  it('is checked against the transcription model, stored encrypted for OpenAI, and the assistant keeps its service', async () => {
    const { web, settings, speech } = setup([json({ id: 'gpt-4o-mini-transcribe', object: 'model', created: 1, owned_by: 'system' })], { withKey: false });
    settings.storeVerifiedKey('anthropic', TEST_KEY, '2026-10-25T00:00:00.000Z');
    expect(await speech.connectKey(OPENAI_KEY)).toEqual({ ok: true });
    expect(web.calls[0].url).toBe('https://api.openai.com/v1/models/gpt-4o-mini-transcribe');
    expect(settings.getProviderId()).toBe('anthropic');
    expect(settings.getApiKey()).toBe(TEST_KEY);
    expect(settings.getProviderKey('openai')).toBe(OPENAI_KEY);
    expect(settings.publicState().speech).toEqual({ available: true });
  });

  it('a rejected or malformed key is not stored', async () => {
    const { settings, speech } = setup([json({ error: {} }, 401)], { withKey: false });
    expect(await speech.connectKey('not-a-key')).toEqual({ ok: false, code: 'INVALID_KEY' });
    expect(await speech.connectKey(OPENAI_KEY)).toEqual({ ok: false, code: 'AUTH' });
    expect(settings.publicState().speech).toEqual({ available: false });
  });
});

describe('IPC', () => {
  it.each([
    ['not an object', 'audio'],
    ['a missing type', { audio: audio() }],
    ['an extra field', { audio: audio(), mimeType: 'audio/webm', send: true }],
    ['audio that is not binary', { audio: 'base64...', mimeType: 'audio/webm' }],
  ])('rejects %s', (_, payload) => {
    expect(validateTranscribePayload(payload)).toEqual({ code: 'INVALID_INPUT' });
  });

  it('transcribe returns only the text; foreign pages are refused; nothing reaches the chat', async () => {
    const { settings, speech } = setup([json({ text: 'Купить молоко' })]);
    const handlers = {};
    const chatCalls = [];
    registerAiHandlers({
      ipcMain: { handle: (channel, handler) => (handlers[channel] = handler) },
      settings,
      connection: createConnection({ settings }),
      chat: { send: async () => chatCalls.push('send'), reset: () => {} },
      speech,
      isTrustedSender: (event) => event.senderFrame?.url === 'app',
    });
    expect(await handlers['ai:transcribe']({ senderFrame: { url: 'file:///evil.html' } }, { audio: audio(), mimeType: 'audio/webm' })).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await handlers['ai:transcribe']({ senderFrame: { url: 'app' } }, { audio: audio(), mimeType: 'audio/webm' })).toEqual({ ok: true, text: 'Купить молоко' });
    expect(chatCalls).toEqual([]);
  });
});
