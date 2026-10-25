// Renders the real app against a fake preload bridge backed by the REAL main-process
// storage module (electron/storage.cjs) in an isolated temp folder. Only the IPC layer
// is replaced: data passes through structuredClone like Electron's IPC serialization.
import { StrictMode } from 'react';
import { createRequire } from 'node:module';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { createFakeAnthropic } from './fakeAnthropic.js';
import { createFakeFetch } from './fakeFetch.js';
import { createFakeSafeStorage } from './fakeSafeStorage.js';
import { createTempDir } from './tempDir.js';

const require = createRequire(import.meta.url);
const { createStorage, FILE_NAME } = require('../../electron/storage.cjs');
const { createAiSettings } = require('../../electron/ai/aiSettings.cjs');
const { registerAiHandlers } = require('../../electron/ai/ipc.cjs');
const { createChatService } = require('../../electron/ai/chatService.cjs');
const { createConnection } = require('../../electron/ai/connection.cjs');
const { createSpeechService } = require('../../electron/ai/speech.cjs');

/**
 * AI bridge backed by the real main-process settings store, connection and IPC handlers (with a fake
 * safeStorage), so tests exercise the same validation the app uses. Payloads are cloned like IPC.
 * The scripted fake client answers both connection tests (`modelInfo()`) and chat requests.
 */
function createAiBridge(dir, safeStorage, storage, anthropic, web, clock) {
  const handlers = {};
  const settings = createAiSettings({ dir, safeStorage });
  const adapterDeps = { createClient: (options) => anthropic.createClient(options), fetch: web.fetch };
  const connection = createConnection({ settings, adapterDeps, now: clock.now });
  // The real chat service and Anthropic adapter; only the SDK client is a scripted fake.
  const chat = createChatService({
    settings,
    onResult: connection.noteRequest,
    getCategories: () => storage.load().categories ?? [],
    getTasks: () => storage.load().tasks ?? [],
    now: clock.now,
    timeZone: clock.timeZone,
    adapterDeps,
  });
  registerAiHandlers({ ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) }, settings, connection, chat, speech: createSpeechService({ settings, fetch: web.fetch }), isTrustedSender: () => true });
  const invoke = async (channel, ...args) => structuredClone(await handlers[channel]({}, ...args.map((arg) => structuredClone(arg))));
  return {
    getSettings: () => invoke('ai:get-settings'),
    saveSettings: (changes) => invoke('ai:save-settings', changes),
    connect: (request) => invoke('ai:connect', request),
    disconnect: () => invoke('ai:disconnect'),
    chat: (request) => invoke('ai:chat', request),
    resetChat: () => invoke('ai:reset-chat'),
    transcribe: (request) => invoke('ai:transcribe', request),
    connectSpeech: (request) => invoke('ai:connect-speech', request),
  };
}

/**
 * Creates the fake bridge. Pass `temp` to reuse a folder (simulating an app restart),
 * `document` to seed the data file before launch.
 */
export function createBridge({
  temp = createTempDir(),
  document,
  safeStorage = createFakeSafeStorage(),
  anthropic = createFakeAnthropic(),
  // Scripted HTTP answers for the OpenAI, Gemini and OpenAI-compatible adapters.
  web = createFakeFetch(),
  clock = { now: () => new Date(), timeZone: () => 'Europe/Moscow' },
} = {}) {
  if (document) temp.writeJson(FILE_NAME, document);
  const storage = createStorage(temp.dir);
  let failures = 0;
  let beforeClose = null;
  const bridge = {
    load: async () => structuredClone(storage.load()),
    saveBoard: async (board) => {
      if (failures > 0) {
        failures -= 1;
        return { ok: false, code: 'EPERM' };
      }
      return storage.saveBoard(structuredClone(board));
    },
    saveSettings: async (settings) => storage.saveSettings(structuredClone(settings)),
    onBeforeClose: (handler) => {
      beforeClose = handler;
    },
  };
  return {
    temp,
    bridge,
    safeStorage,
    anthropic,
    web,
    aiBridge: createAiBridge(temp.dir, safeStorage, storage, anthropic, web, clock),
    readData: () => temp.readJson(FILE_NAME),
    failNextSaves: (count) => {
      failures = count;
    },
    runBeforeClose: () => beforeClose?.(),
  };
}

/**
 * Boots the app exactly like src/main.jsx (load first, then render AppRoot in StrictMode).
 * Modules are re-imported per call so the renderer storage singleton starts clean.
 */
export async function renderApp(options = {}) {
  const env = createBridge(options);
  window.taskflow = Object.freeze({ platform: 'win32', isDesktop: true, storage: env.bridge, ai: Object.freeze(env.aiBridge) });
  vi.resetModules();
  const { loadAppData } = await import('../../src/storage/storage.js');
  const { default: AppRoot } = await import('../../src/AppRoot.jsx');
  const boot = await loadAppData();
  const user = userEvent.setup();
  const utils = render(
    <StrictMode>
      <AppRoot boot={boot} />
    </StrictMode>,
  );
  return { ...env, ...utils, user, boot };
}
