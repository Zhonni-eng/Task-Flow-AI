// @vitest-environment node
// AI IPC handlers (electron/ai/ipc.cjs): sender checks, payload validation and what the renderer
// can ever receive. Uses the real settings store and connection with a fake safeStorage and a fake
// Anthropic client, in a temp folder.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeAnthropic, modelInfo } from '../helpers/fakeAnthropic.js';
import { createFakeSafeStorage, TEST_KEY } from '../helpers/fakeSafeStorage.js';
import { createTempDir } from '../helpers/tempDir.js';

const require = createRequire(import.meta.url);
const { registerAiHandlers, validateConnectPayload, CHANNELS } = require('../../electron/ai/ipc.cjs');
const { createAiSettings } = require('../../electron/ai/aiSettings.cjs');
const { createConnection } = require('../../electron/ai/connection.cjs');

let temp;
let handlers;
let settings;
let connection;
let fake;
const trusted = { senderFrame: { url: 'app' } };
const foreign = { senderFrame: { url: 'file:///C:/Users/someone/evil.html' } };

beforeEach(() => {
  temp = createTempDir();
  settings = createAiSettings({ dir: temp.dir, safeStorage: createFakeSafeStorage() });
  fake = createFakeAnthropic([modelInfo(), modelInfo(), modelInfo()]);
  connection = createConnection({ settings, adapterDeps: { createClient: (options) => fake.createClient(options) } });
  const registered = {};
  registerAiHandlers({
    ipcMain: { handle: (channel, handler) => (registered[channel] = handler) },
    settings,
    connection,
    isTrustedSender: (event) => event.senderFrame?.url === 'app',
  });
  handlers = registered;
});
afterEach(() => {
  temp.remove();
});

const call = (channel, event, ...args) => handlers[channel](event, ...args);

describe('registered channels', () => {
  it('registers exactly the eight AI channels', () => {
    expect(Object.keys(handlers).sort()).toEqual(['ai:chat', 'ai:connect', 'ai:connect-speech', 'ai:disconnect', 'ai:get-settings', 'ai:reset-chat', 'ai:save-settings', 'ai:transcribe']);
    expect(Object.values(CHANNELS).sort()).toEqual(Object.keys(handlers).sort());
  });

  it('the preload exposes only these eight operations, through ipcRenderer.invoke (no generic IPC)', () => {
    const preload = fs.readFileSync(path.join(import.meta.dirname, '../../electron/preload.cjs'), 'utf8');
    const block = preload.slice(preload.indexOf('const ai = Object.freeze({'), preload.indexOf('});', preload.indexOf('const ai = Object.freeze({')));
    expect([...block.matchAll(/^\s+(\w+): /gm)].map((match) => match[1])).toEqual(['getSettings', 'saveSettings', 'connect', 'disconnect', 'chat', 'resetChat', 'transcribe', 'connectSpeech']);
    expect([...block.matchAll(/ipcRenderer\.(\w+)\('([^']+)'/g)].map((match) => `${match[1]}:${match[2]}`)).toEqual([
      'invoke:ai:get-settings',
      'invoke:ai:save-settings',
      'invoke:ai:connect',
      'invoke:ai:disconnect',
      'invoke:ai:chat',
      'invoke:ai:reset-chat',
      'invoke:ai:transcribe',
      'invoke:ai:connect-speech',
    ]);
    expect(preload).not.toMatch(/getApiKey|ai:get-key|ai:set-key/);
  });
});

describe('sender validation', () => {
  it.each(Object.values(CHANNELS))('%s refuses any page other than the app', (channel) => {
    const payload = channel === CHANNELS.connect ? { key: TEST_KEY } : channel === CHANNELS.chat ? { message: 'hi' } : { enabled: true };
    expect(call(channel, foreign, payload)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(call(channel, {})).toEqual({ ok: false, code: 'FORBIDDEN' });
  });

  it('a refused sender changes nothing and sends nothing', () => {
    call(CHANNELS.connect, foreign, { key: TEST_KEY });
    call(CHANNELS.saveSettings, foreign, { enabled: true });
    expect(temp.list()).toEqual([]);
    expect(fake.clients).toHaveLength(0);
  });
});

describe('payload validation', () => {
  it.each([
    ['null', null],
    ['an array', [{ enabled: true }]],
    ['a string', 'enabled'],
    ['an empty object', {}],
    ['an unknown field', { enabled: false, apiKey: TEST_KEY }],
    ['a prototype-polluting field', JSON.parse('{"__proto__": {"enabled": true}}')],
    ['a non-boolean enabled', { enabled: 'true' }],
    ['a provider choice', { provider: 'anthropic' }],
    ['a model choice', { model: 'claude-haiku-5-5' }],
  ])('rejects %s', (_, payload) => {
    const result = call(CHANNELS.saveSettings, trusted, payload);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_INPUT');
    expect(temp.list()).toEqual([]);
  });

  it.each([
    ['a bare string', TEST_KEY, 'INVALID_INPUT'],
    ['a number', 42, 'INVALID_INPUT'],
    ['an array', [TEST_KEY], 'INVALID_INPUT'],
    ['an extra field', { key: TEST_KEY, endpoint: 'https://example.test' }, 'INVALID_INPUT'],
    ['an unknown provider', { key: TEST_KEY, provider: 'mystery' }, 'INVALID_INPUT'],
    ['a non-string base URL', { key: TEST_KEY, provider: 'openai-compatible', baseUrl: 42, model: 'm' }, 'INVALID_INPUT'],
    ['an oversized model id', { key: TEST_KEY, provider: 'openai-compatible', baseUrl: 'https://x.test/v1', model: 'm'.repeat(301) }, 'INVALID_INPUT'],
    ['no key with a provider', { provider: 'openai' }, 'INVALID_INPUT'],
    ['an empty object', {}, 'INVALID_INPUT'],
    ['a non-string key', { key: 42 }, 'INVALID_KEY'],
    ['an empty key', { key: '  ' }, 'INVALID_KEY'],
    ['an oversized key', { key: 'x'.repeat(513) }, 'INVALID_KEY'],
  ])('connect rejects %s without any request', async (_, payload, code) => {
    expect((await call(CHANNELS.connect, trusted, payload)).code).toBe(code);
    expect(fake.clients).toHaveLength(0);
    expect(temp.list()).toEqual([]);
  });

  it('validateConnectPayload: no payload means "check the stored key again"', () => {
    expect(validateConnectPayload(undefined)).toEqual({ request: {} });
    expect(validateConnectPayload({ key: TEST_KEY })).toEqual({ request: { key: TEST_KEY, provider: 'auto', baseUrl: undefined, model: undefined } });
    expect(validateConnectPayload({ key: TEST_KEY, provider: 'openai-compatible', baseUrl: 'https://x.test/v1', model: 'm' }).request).toMatchObject({ provider: 'openai-compatible', baseUrl: 'https://x.test/v1', model: 'm' });
  });

  it('enabling before connecting is refused; connecting enables; switching off works', async () => {
    expect(call(CHANNELS.saveSettings, trusted, { enabled: true })).toMatchObject({ ok: false, code: 'NOT_CONNECTED', state: { enabled: false, connection: 'none' } });
    expect(await call(CHANNELS.connect, trusted, { key: TEST_KEY })).toMatchObject({ ok: true, state: { enabled: true, connection: 'connected' } });
    expect(call(CHANNELS.saveSettings, trusted, { enabled: false })).toMatchObject({ ok: true, state: { enabled: false } });
  });
});

describe('what the renderer can receive', () => {
  it('no response ever contains a key or a model; only the advanced section names the provider id', async () => {
    const responses = [
      await call(CHANNELS.connect, trusted, { key: TEST_KEY }),
      call(CHANNELS.getSettings, trusted),
      call(CHANNELS.saveSettings, trusted, { enabled: true }),
      await call(CHANNELS.connect, trusted, { key: 'sk-ant-bad key with spaces 1234567890' }),
      await call(CHANNELS.connect, trusted),
      call(CHANNELS.disconnect, trusted),
    ];
    for (const response of responses) {
      const text = JSON.stringify(response);
      expect(text).not.toContain(TEST_KEY);
      expect(text).not.toContain('sk-ant');
      const { advanced, ...rest } = response.state ?? {};
      expect(JSON.stringify(rest)).not.toMatch(/anthropic|claude|gpt-|gemini-/i);
      expect(Object.keys(response.state ?? {}).sort()).toEqual(['advanced', 'connection', 'enabled', 'key', 'secureStorage', 'speech', 'status', 'verifiedAt', 'writable']);
    }
    expect(responses[0]).toMatchObject({ ok: true, state: { key: 'stored', connection: 'connected', advanced: { provider: 'anthropic', model: 'claude-opus-5-5', compatible: null } } });
    expect(responses[3]).toMatchObject({ ok: false, code: 'INVALID_KEY', state: { key: 'stored' } });
    expect(responses[5]).toMatchObject({ ok: true, state: { key: 'none', connection: 'none' } });
  });

  it('exceptions inside the connection become a generic code without their message', async () => {
    connection.connect = async () => {
      throw new Error(`boom ${TEST_KEY}`);
    };
    const result = await call(CHANNELS.connect, trusted, { key: TEST_KEY });
    expect(result).toEqual({ ok: false, code: 'INTERNAL' });
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });
});

describe('chat channel', () => {
  const chatCalls = [];
  const fakeChat = {
    send: async (message, language, recentTaskIds) => {
      chatCalls.push({ message, language, recentTaskIds });
      return { ok: true, plan: { reply: 'ok', question: '', actions: [{ type: 'none' }] }, provider: 'anthropic', model: 'claude-opus-5-5', history: ['must not leak'] };
    },
    reset: () => chatCalls.push('reset'),
  };
  let chatHandlers;
  beforeEach(() => {
    chatCalls.length = 0;
    const registered = {};
    registerAiHandlers({ ipcMain: { handle: (channel, handler) => (registered[channel] = handler) }, settings, connection, chat: fakeChat, isTrustedSender: (event) => event.senderFrame?.url === 'app' });
    chatHandlers = registered;
  });

  it.each([
    ['null', null, 'INVALID_INPUT'],
    ['a bare string', 'buy milk', 'INVALID_INPUT'],
    ['no message', { language: 'ru' }, 'INVALID_INPUT'],
    ['an extra field', { message: 'x', history: [] }, 'INVALID_INPUT'],
    ['a forged plan', { message: 'x', plan: { actions: [{ type: 'create', title: 'X' }] } }, 'INVALID_INPUT'],
    ['an unknown language', { message: 'x', language: 'de' }, 'INVALID_INPUT'],
    ['an empty message', { message: '   ' }, 'INVALID_MESSAGE'],
    ['an oversized message', { message: 'x'.repeat(2001) }, 'INVALID_MESSAGE'],
    ['a non-string message', { message: 42 }, 'INVALID_MESSAGE'],
  ])('rejects %s before anything is sent', async (_, payload, code) => {
    expect(await chatHandlers['ai:chat'](trusted, payload)).toEqual({ ok: false, code });
    expect(chatCalls).toEqual([]);
  });

  it('passes a valid message on and returns only the plan and shared task ids', async () => {
    const result = await chatHandlers['ai:chat'](trusted, { message: 'Купить молоко', language: 'en', recentTaskIds: ['t1'] });
    expect(chatCalls).toEqual([{ message: 'Купить молоко', language: 'en', recentTaskIds: ['t1'] }]);
    expect(Object.keys(result).sort()).toEqual(['ok', 'plan', 'sharedTaskIds', 'usage']);
    expect(JSON.stringify(result)).not.toContain('must not leak');
  });

  it('rejected promises from the chat service become a generic code', async () => {
    fakeChat.send = async () => {
      throw new Error(`boom ${TEST_KEY}`);
    };
    expect(await chatHandlers['ai:chat'](trusted, { message: 'x' })).toEqual({ ok: false, code: 'INTERNAL' });
  });

  it('reset is sender-checked too', () => {
    expect(chatHandlers['ai:reset-chat'](foreign)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(chatCalls).toEqual([]);
    expect(chatHandlers['ai:reset-chat'](trusted)).toEqual({ ok: true });
    expect(chatCalls).toEqual(['reset']);
  });
});

describe('chat channel: recent task ids (Stage 3)', () => {
  it.each([
    ['not an array', { message: 'x', recentTaskIds: 'id' }],
    ['a non-string id', { message: 'x', recentTaskIds: [1] }],
    ['an empty id', { message: 'x', recentTaskIds: [''] }],
    ['an oversized id', { message: 'x', recentTaskIds: ['x'.repeat(101)] }],
    ['too many ids', { message: 'x', recentTaskIds: Array.from({ length: 51 }, (_, i) => `t${i}`) }],
  ])('rejects %s', async (_, payload) => {
    let called = false;
    const registered = {};
    registerAiHandlers({ ipcMain: { handle: (c, h) => (registered[c] = h) }, settings, connection, chat: { send: async () => ((called = true), { ok: true, plan: {} }) }, isTrustedSender: () => true });
    expect(await registered['ai:chat'](trusted, payload)).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(called).toBe(false);
  });
});
