// @vitest-environment node
// Provider detection (electron/ai/providers.cjs) and the connection flow (electron/ai/connection.cjs):
// a key is tested by exactly one provider before it is stored, a failed test never replaces a
// working configuration, keys stay with their own provider, and the status distinguishes "verified
// in this session" from "a key is stored". Fake clients and a fake fetch only - no network.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeAnthropic, modelInfo, planResponse } from '../helpers/fakeAnthropic.js';
import { createFakeFetch, json } from '../helpers/fakeFetch.js';
import { createFakeSafeStorage, OTHER_TEST_KEY, TEST_KEY } from '../helpers/fakeSafeStorage.js';
import { createTempDir } from '../helpers/tempDir.js';

const require = createRequire(import.meta.url);
const { detectProvider, normalizeBaseUrl, PROVIDERS } = require('../../electron/ai/providers.cjs');
const { createConnection } = require('../../electron/ai/connection.cjs');
const { createAiSettings, FILE_NAME } = require('../../electron/ai/aiSettings.cjs');
const { createChatService } = require('../../electron/ai/chatService.cjs');
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default ?? sdk;

const NOW = new Date('2026-10-24T08:00:00.000Z');
const statusError = (Class, status) => new Class(status, { type: 'error', error: { type: 'x', message: `secret ${TEST_KEY}` } }, `failure ${TEST_KEY}`, new Headers());

let temp;
let safeStorage;
beforeEach(() => {
  temp = createTempDir();
  safeStorage = createFakeSafeStorage();
});
afterEach(() => {
  temp.remove();
});

// `script` answers Anthropic SDK calls; `http` answers fetch calls (OpenAI, Gemini, compatible).
const setup = (script = [], http = []) => {
  const fake = createFakeAnthropic(script);
  const web = createFakeFetch(http);
  const settings = createAiSettings({ dir: temp.dir, safeStorage });
  const adapterDeps = { createClient: (options) => fake.createClient(options), fetch: web.fetch };
  const connection = createConnection({ settings, adapterDeps, now: () => NOW });
  return { fake, web, settings, connection, adapterDeps };
};
const OPENAI_KEY = 'sk-proj-test-0123456789abcdefghijklmn';
const GEMINI_KEY = 'AIzaTest0123456789abcdefghijklmnopqrs';
const NEW_STYLE_KEY = 'AQ.new-style-test-key-0123456789abcdef';
const openAiModel = () => json({ id: 'gpt-6-luna', object: 'model', created: 1, owned_by: 'openai' });
const geminiModel = () => json({ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] });

describe('provider detection', () => {
  it.each([
    ['an Anthropic key', TEST_KEY, 'anthropic'],
    ['an OpenAI project key', OPENAI_KEY, 'openai'],
    ['a classic OpenAI key', 'sk-0123456789abcdefghijklmnopqrstuvwx', 'openai'],
    ['a classic Google API key', GEMINI_KEY, 'gemini'],
  ])('a key shape suggests one candidate: %s -> %s', (_, key, id) => {
    expect(detectProvider(key).provider.id).toBe(id);
  });

  it.each([
    ['a new-style key without a documented format', NEW_STYLE_KEY],
    ['a bare token', 'abcdefghijklmnopqrstuvwxyz0123456789'],
  ])('does not guess: %s is unidentified (the user chooses the service)', (_, key) => {
    expect(detectProvider(key)).toEqual({ code: 'UNIDENTIFIED_KEY' });
  });

  it('a suggested provider with a malformed key is an invalid key, not another provider', () => {
    expect(detectProvider('sk-ant-short')).toEqual({ code: 'INVALID_KEY' });
    expect(detectProvider('sk-short')).toEqual({ code: 'INVALID_KEY' });
    expect(detectProvider('')).toEqual({ code: 'INVALID_KEY' });
  });

  it('several suggested providers are ambiguous and refused', () => {
    const make = (id, keyHint) => ({ id, keyHint, isApiKeyFormat: () => true });
    expect(detectProvider('tk-1', [make('a', /^tk-/), make('b', /^tk/)])).toEqual({ code: 'AMBIGUOUS_KEY' });
  });

  it('the registry has Anthropic, OpenAI, Gemini and the configurable OpenAI-compatible provider', () => {
    expect(PROVIDERS.map((provider) => [provider.id, provider.model])).toEqual([
      ['anthropic', 'claude-opus-5-5'],
      ['openai', 'gpt-6-luna'],
      ['gemini', 'gemini-3.8-flash'],
      ['openai-compatible', null],
    ]);
    // The compatible provider is never suggested by a key: it is only used when chosen.
    expect(PROVIDERS.find((provider) => provider.id === 'openai-compatible').keyHint).toBeNull();
  });

  it.each([
    ['https://llm.example.test/v1/', 'https://llm.example.test/v1'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1'],
    ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1'],
    ['http://llm.example.test/v1', null],
    ['https://user:pass@llm.example.test/v1', null],
    ['https://llm.example.test/v1?key=x', null],
    ['ftp://llm.example.test', null],
    ['not a url', null],
  ])('base URL %s -> %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });
});

describe('connecting', () => {
  it('starts disconnected; nothing is sent until Connect', () => {
    const { fake, connection } = setup();
    expect(connection.publicState()).toMatchObject({ connection: 'none', enabled: false, key: 'none' });
    expect(fake.clients).toHaveLength(0);
  });

  it('a working key: tested with one model request (no task data), then stored encrypted, connected and enabled', async () => {
    const { fake, settings, connection } = setup([modelInfo()]);
    expect(await connection.connect({ key: `  ${TEST_KEY} ` })).toEqual({ ok: true });
    expect(fake.modelRequests).toEqual(['claude-opus-5-5']);
    expect(fake.requests).toHaveLength(0);
    expect(fake.clients[0].apiKey).toBe(TEST_KEY);
    const state = connection.publicState();
    expect(state).toMatchObject({ connection: 'connected', enabled: true, key: 'stored', verifiedAt: NOW.toISOString() });
    expect(JSON.stringify(state)).not.toContain(TEST_KEY);
    expect(settings.getApiKey()).toBe(TEST_KEY);
    expect(fs.readFileSync(temp.file(FILE_NAME), 'utf8')).not.toContain(TEST_KEY);
  });

  it.each([
    ['an invalid key (401)', () => statusError(Anthropic.AuthenticationError, 401), 'AUTH'],
    ['no access (403)', () => statusError(Anthropic.PermissionDeniedError, 403), 'PERMISSION'],
    ['a rate limit (429)', () => statusError(Anthropic.RateLimitError, 429), 'RATE_LIMIT'],
    ['an outage (500)', () => statusError(Anthropic.InternalServerError, 500), 'PROVIDER_ERROR'],
    ['an overload (529)', () => statusError(Anthropic.APIError, 529), 'OVERLOADED'],
    ['a timeout', () => new Anthropic.APIConnectionTimeoutError(), 'TIMEOUT'],
    ['a network error', () => new Anthropic.APIConnectionError({ message: 'Connection error.' }), 'NETWORK'],
    ['an unsupported response', () => ({ type: 'something-else' }), 'MALFORMED'],
  ])('%s: no success is reported and nothing is stored', async (_, make, code) => {
    const { connection } = setup([make()]);
    expect(await connection.connect({ key: TEST_KEY })).toEqual({ ok: false, code });
    expect(connection.publicState()).toMatchObject({ connection: 'none', key: 'none', enabled: false });
    expect(temp.list()).toEqual([]);
  });

  it('an adapter that throws unexpectedly is a failure too', async () => {
    const { connection } = setup([() => Promise.reject(new TypeError('boom'))]);
    expect((await connection.connect({ key: TEST_KEY })).ok).toBe(false);
    expect(temp.list()).toEqual([]);
  });

  it.each([
    ['unidentified', 'abcdefghijklmnopqrstuvwxyz0123456789', 'UNIDENTIFIED_KEY'],
    ['malformed', 'sk-ant-short', 'INVALID_KEY'],
    ['empty', '   ', 'INVALID_KEY'],
  ])('an %s key is refused locally - no request is made to any service', async (_, key, code) => {
    const { fake, web, connection } = setup([modelInfo()]);
    expect(await connection.connect({ key: key })).toEqual({ ok: false, code });
    expect(fake.clients).toHaveLength(0);
    expect(web.calls).toHaveLength(0);
  });

  it('a key that could not be stored is not tested at all', async () => {
    safeStorage = createFakeSafeStorage({ available: false });
    const { fake, connection } = setup([modelInfo()]);
    expect(await connection.connect({ key: TEST_KEY })).toEqual({ ok: false, code: 'SECURE_STORAGE_UNAVAILABLE' });
    expect(fake.clients).toHaveLength(0);
  });

  it('a failed replacement key never replaces the working one', async () => {
    const { settings, connection } = setup([modelInfo(), statusError(Anthropic.AuthenticationError, 401), new Anthropic.APIConnectionTimeoutError()]);
    await connection.connect({ key: TEST_KEY });
    expect(await connection.connect({ key: OTHER_TEST_KEY })).toEqual({ ok: false, code: 'AUTH' });
    expect(await connection.connect({ key: OTHER_TEST_KEY })).toEqual({ ok: false, code: 'TIMEOUT' });
    expect(settings.getApiKey()).toBe(TEST_KEY);
    expect(connection.publicState()).toMatchObject({ connection: 'connected', enabled: true, verifiedAt: NOW.toISOString() });
  });

  it('a working replacement key replaces the old one', async () => {
    const { settings, connection } = setup([modelInfo(), modelInfo()]);
    await connection.connect({ key: TEST_KEY });
    expect(await connection.connect({ key: OTHER_TEST_KEY })).toEqual({ ok: true });
    expect(settings.getApiKey()).toBe(OTHER_TEST_KEY);
  });

  it('one check at a time', async () => {
    let release;
    const { connection } = setup([() => new Promise((resolve) => (release = () => resolve(modelInfo())))]);
    const first = connection.connect({ key: TEST_KEY });
    expect(await connection.connect({ key: TEST_KEY })).toEqual({ ok: false, code: 'BUSY' });
    await Promise.resolve();
    release();
    expect(await first).toEqual({ ok: true });
  });
});

describe('after a restart and when re-checking', () => {
  const restart = (script = []) => setup(script);

  it('a stored key is "saved", not "connected", until it is checked again in this session', async () => {
    await setup([modelInfo()]).connection.connect({ key: TEST_KEY });
    const { fake, connection } = restart([modelInfo()]);
    expect(connection.publicState()).toMatchObject({ connection: 'saved', enabled: true, verifiedAt: NOW.toISOString() });
    expect(fake.clients).toHaveLength(0); // nothing is checked automatically
    expect(await connection.connect()).toEqual({ ok: true });
    expect(fake.clients[0].apiKey).toBe(TEST_KEY);
    expect(connection.publicState().connection).toBe('connected');
  });

  it('re-checking the stored key: a rejected key becomes "failed" but stays stored; a network error changes nothing', async () => {
    await setup([modelInfo()]).connection.connect({ key: TEST_KEY });
    const { settings, connection } = restart([new Anthropic.APIConnectionError({ message: 'x' }), statusError(Anthropic.AuthenticationError, 401)]);
    expect(await connection.connect()).toEqual({ ok: false, code: 'NETWORK' });
    expect(connection.publicState().connection).toBe('saved');
    expect(await connection.connect()).toEqual({ ok: false, code: 'AUTH' });
    expect(connection.publicState().connection).toBe('failed');
    expect(settings.getApiKey()).toBe(TEST_KEY);
  });

  it('re-checking without a stored key asks for one', async () => {
    const { fake, connection } = setup([modelInfo()]);
    expect(await connection.connect()).toEqual({ ok: false, code: 'NO_KEY' });
    expect(fake.clients).toHaveLength(0);
  });

  it('a key from an earlier build is "unverified" until a check succeeds', async () => {
    const encrypted = Buffer.from(safeStorage.encryptString(TEST_KEY)).toString('base64');
    temp.writeJson(FILE_NAME, { version: 1, enabled: false, provider: 'anthropic', credentials: { anthropic: encrypted } });
    const { settings, connection } = setup([modelInfo()]);
    expect(connection.publicState()).toMatchObject({ connection: 'unverified', verifiedAt: null });
    expect(settings.saveSettings({ enabled: true })).toEqual({ ok: false, code: 'NOT_CONNECTED' });
    expect(await connection.connect()).toEqual({ ok: true });
    expect(connection.publicState()).toMatchObject({ connection: 'connected', verifiedAt: NOW.toISOString() });
    expect(settings.saveSettings({ enabled: true })).toEqual({ ok: true });
  });

  it('chat requests update the status: success connects, a rejected key fails', async () => {
    await setup([modelInfo()]).connection.connect({ key: TEST_KEY });
    const fake = createFakeAnthropic([planResponse(), statusError(Anthropic.AuthenticationError, 401)]);
    const settings = createAiSettings({ dir: temp.dir, safeStorage });
    const connection = createConnection({ settings });
    const chat = createChatService({ settings, onResult: connection.noteRequest, adapterDeps: { createClient: (options) => fake.createClient(options) } });
    expect(connection.publicState().connection).toBe('saved');
    await chat.send('x', 'ru');
    expect(connection.publicState().connection).toBe('connected');
    await chat.send('y', 'ru');
    expect(connection.publicState().connection).toBe('failed');
  });
});

describe('disconnecting', () => {
  it('removes the key, switches AI off and resets the status', async () => {
    const { settings, connection } = setup([modelInfo()]);
    await connection.connect({ key: TEST_KEY });
    expect(connection.disconnect()).toEqual({ ok: true });
    expect(connection.publicState()).toMatchObject({ connection: 'none', key: 'none', enabled: false, verifiedAt: null });
    expect(settings.getApiKey()).toBeNull();
  });
});

describe('several providers', () => {
  it('an OpenAI key goes only to OpenAI and is stored under OpenAI', async () => {
    const { fake, web, settings, connection } = setup([], [openAiModel()]);
    expect(await connection.connect({ key: OPENAI_KEY })).toEqual({ ok: true });
    expect(web.calls.map((call) => call.url)).toEqual(['https://api.openai.com/v1/models/gpt-6-luna']);
    expect(fake.clients).toHaveLength(0);
    expect(settings.getTarget()).toEqual({ providerId: 'openai', model: 'gpt-6-luna', baseUrl: null });
    expect(connection.publicState()).toMatchObject({ connection: 'connected', enabled: true, advanced: { provider: 'openai' } });
  });

  it('a Google key goes only to Gemini', async () => {
    const { web, settings, connection } = setup([], [geminiModel()]);
    expect(await connection.connect({ key: GEMINI_KEY })).toEqual({ ok: true });
    expect(web.calls.map((call) => call.url)).toEqual(['https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash']);
    expect(settings.getTarget().providerId).toBe('gemini');
  });

  it('a key of unknown shape works when the service is chosen explicitly - and only that service receives it', async () => {
    const { fake, web, settings, connection } = setup([], [geminiModel()]);
    expect(await connection.connect({ key: NEW_STYLE_KEY })).toEqual({ ok: false, code: 'UNIDENTIFIED_KEY' });
    expect(web.calls).toHaveLength(0);
    expect(await connection.connect({ key: NEW_STYLE_KEY, provider: 'gemini' })).toEqual({ ok: true });
    expect(web.calls).toHaveLength(1);
    expect(web.calls[0].headers['x-goog-api-key']).toBe(NEW_STYLE_KEY);
    expect(fake.clients).toHaveLength(0);
    expect(settings.getApiKey()).toBe(NEW_STYLE_KEY);
  });

  it('an explicit choice that rejects the key reports it and never tries another service', async () => {
    const { fake, web, connection } = setup([modelInfo()], [json({ error: { message: 'x' } }, 401)]);
    expect(await connection.connect({ key: TEST_KEY, provider: 'openai' })).toEqual({ ok: false, code: 'AUTH' });
    expect(web.calls).toHaveLength(1);
    expect(fake.clients).toHaveLength(0);
  });

  it('credential isolation: each key is stored under its provider and only ever sent to it', async () => {
    const { fake, web, settings, connection, adapterDeps } = setup([modelInfo(), planResponse()], [openAiModel(), json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ reply: 'ok', question: '', tasks: [], statusChanges: [], dueDateChanges: [] }) }] }] })]);
    await connection.connect({ key: TEST_KEY });
    await connection.connect({ key: OPENAI_KEY });
    const file = JSON.parse(fs.readFileSync(temp.file(FILE_NAME), 'utf8'));
    expect(Object.keys(file.credentials).sort()).toEqual(['anthropic', 'openai']);
    expect(JSON.stringify(file)).not.toContain(TEST_KEY);
    expect(JSON.stringify(file)).not.toContain(OPENAI_KEY);
    // The active connection is OpenAI: chat goes there with the OpenAI key only.
    const chat = createChatService({ settings, adapterDeps });
    expect((await chat.send('x', 'ru')).ok).toBe(true);
    expect(fake.clients.map((client) => client.apiKey)).toEqual([TEST_KEY]);
    expect(web.calls.map((call) => call.headers.authorization)).toEqual([`Bearer ${OPENAI_KEY}`, `Bearer ${OPENAI_KEY}`]);
    expect(web.calls[1].url).toBe('https://api.openai.com/v1/responses');
  });

  it('a failed attempt with another provider keeps the working configuration', async () => {
    const { settings, connection } = setup([modelInfo()], [new TypeError('fetch failed')]);
    await connection.connect({ key: TEST_KEY });
    expect(await connection.connect({ key: OPENAI_KEY })).toEqual({ ok: false, code: 'NETWORK' });
    expect(settings.getTarget()).toEqual({ providerId: 'anthropic', model: 'claude-opus-5-5', baseUrl: null });
    expect(settings.getApiKey()).toBe(TEST_KEY);
    expect(connection.publicState()).toMatchObject({ connection: 'connected', advanced: { provider: 'anthropic' } });
  });

  it('disconnecting removes the keys of every provider', async () => {
    const { connection } = setup([modelInfo()], [openAiModel()]);
    await connection.connect({ key: TEST_KEY });
    await connection.connect({ key: OPENAI_KEY });
    connection.disconnect();
    expect(JSON.parse(fs.readFileSync(temp.file(FILE_NAME), 'utf8'))).toMatchObject({ credentials: {}, compatible: null, enabled: false });
  });
});

describe('OpenAI-compatible API (advanced)', () => {
  const BASE_URL = 'https://llm.example.test/v1';
  const LOCAL_TOKEN = 'local-test-token';
  const models = (...ids) => json({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });

  it('needs a valid base URL and model id; nothing is sent otherwise', async () => {
    const { web, connection } = setup([], [models('m')]);
    expect(await connection.connect({ key: LOCAL_TOKEN, provider: 'openai-compatible', model: 'm' })).toEqual({ ok: false, code: 'INVALID_BASE_URL' });
    expect(await connection.connect({ key: LOCAL_TOKEN, provider: 'openai-compatible', baseUrl: 'http://llm.example.test/v1', model: 'm' })).toEqual({ ok: false, code: 'INVALID_BASE_URL' });
    expect(await connection.connect({ key: LOCAL_TOKEN, provider: 'openai-compatible', baseUrl: BASE_URL, model: 'bad model id' })).toEqual({ ok: false, code: 'INVALID_MODEL' });
    expect(web.calls).toHaveLength(0);
  });

  it('a working configuration is stored (key encrypted, address and model as settings) and used for chat', async () => {
    const { web, settings, connection, adapterDeps } = setup([], [models('local-model'), json({ choices: [{ message: { content: JSON.stringify({ reply: 'ok', question: '', tasks: [], statusChanges: [], dueDateChanges: [] }) }, finish_reason: 'stop' }] })]);
    expect(await connection.connect({ key: LOCAL_TOKEN, provider: 'openai-compatible', baseUrl: `${BASE_URL}/`, model: 'local-model' })).toEqual({ ok: true });
    expect(settings.getTarget()).toEqual({ providerId: 'openai-compatible', model: 'local-model', baseUrl: BASE_URL });
    expect(connection.publicState().advanced).toEqual({ provider: 'openai-compatible', model: 'local-model', compatible: { baseUrl: BASE_URL, model: 'local-model' } });
    const chat = createChatService({ settings, adapterDeps });
    expect((await chat.send('x', 'ru')).ok).toBe(true);
    expect(web.calls.map((call) => call.url)).toEqual([`${BASE_URL}/models`, `${BASE_URL}/chat/completions`]);
    expect(web.calls[1].body.model).toBe('local-model');
  });

  it('a failed new configuration never overwrites the saved one', async () => {
    const { settings, connection } = setup([], [models('local-model'), json({ error: {} }, 404)]);
    await connection.connect({ key: LOCAL_TOKEN, provider: 'openai-compatible', baseUrl: BASE_URL, model: 'local-model' });
    expect(await connection.connect({ key: 'other-token', provider: 'openai-compatible', baseUrl: 'https://other.example.test/v1', model: 'x' })).toEqual({ ok: false, code: 'ENDPOINT_NOT_FOUND' });
    expect(settings.getTarget()).toEqual({ providerId: 'openai-compatible', model: 'local-model', baseUrl: BASE_URL });
    expect(settings.getApiKey()).toBe(LOCAL_TOKEN);
  });
});

describe('model selection', () => {
  it('OpenAI defaults to gpt-6-luna, verified with exactly that id', async () => {
    const { web, settings, connection } = setup([], [json({ id: 'gpt-6-luna', object: 'model', created: 1, owned_by: 'openai' })]);
    expect(await connection.connect({ key: OPENAI_KEY })).toEqual({ ok: true });
    expect(web.calls[0].url).toBe('https://api.openai.com/v1/models/gpt-6-luna');
    expect(settings.getTarget().model).toBe('gpt-6-luna');
  });

  it('an unavailable model fails the connection - no other model is tried, nothing is stored', async () => {
    const { web, connection } = setup([], [json({ error: { message: 'model not found' } }, 404)]);
    expect(await connection.connect({ key: OPENAI_KEY })).toEqual({ ok: false, code: 'MODEL_UNAVAILABLE' });
    expect(web.calls).toHaveLength(1);
    expect(temp.list()).toEqual([]);
  });

  it('a model chosen in the advanced settings is verified, remembered and used', async () => {
    const { web, settings, connection } = setup([], [json({ id: 'gpt-6.1-sol', object: 'model', created: 1, owned_by: 'openai' })]);
    expect(await connection.connect({ key: OPENAI_KEY, provider: 'openai', model: 'gpt-6.1-sol' })).toEqual({ ok: true });
    expect(web.calls[0].url).toBe('https://api.openai.com/v1/models/gpt-6.1-sol');
    expect(settings.getTarget()).toEqual({ providerId: 'openai', model: 'gpt-6.1-sol', baseUrl: null });
    expect(JSON.parse(fs.readFileSync(temp.file(FILE_NAME), 'utf8')).models).toEqual({ openai: 'gpt-6.1-sol' });
  });

  it('an invalid model id is refused locally', async () => {
    const { web, connection } = setup();
    expect(await connection.connect({ key: OPENAI_KEY, model: 'bad model id' })).toEqual({ ok: false, code: 'INVALID_MODEL' });
    expect(web.calls).toHaveLength(0);
  });

  it('chat results carry the provider-reported tokens and a cost estimate only for models with a known price', async () => {
    const { settings, connection, adapterDeps, web } = setup([], [json({ id: 'gpt-6-luna', object: 'model', created: 1, owned_by: 'openai' })]);
    await connection.connect({ key: OPENAI_KEY });
    web.push(json({ status: 'completed', usage: { input_tokens: 1000, output_tokens: 200 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ reply: 'ok', question: '', actions: [] }) }] }] }));
    const result = await createChatService({ settings, adapterDeps }).send('x', 'ru');
    // 1000 * $0.10 / 1M + 200 * $0.50 / 1M
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200, model: 'gpt-6-luna', costUsd: 0.0002 });
  });

  it('no cost is made up for a model without a verified price', async () => {
    const { settings, connection, adapterDeps } = setup([modelInfo(), planResponse()]);
    await connection.connect({ key: TEST_KEY });
    const result = await createChatService({ settings, adapterDeps }).send('x', 'ru');
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 10, model: 'claude-opus-5-5', costUsd: null });
  });
});
