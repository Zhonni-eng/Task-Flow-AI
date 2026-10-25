// Renderer-side storage client (src/storage/storage.js) against a scripted preload bridge.
import { afterEach, describe, expect, it, vi } from 'vitest';

function fakeBridge(loadResult) {
  const calls = { saveBoard: [], saveSettings: [] };
  return {
    calls,
    bridge: {
      load: vi.fn(async () => structuredClone(loadResult)),
      saveBoard: vi.fn(async (board) => {
        calls.saveBoard.push(structuredClone(board));
        return { ok: true };
      }),
      saveSettings: vi.fn(async (settings) => {
        calls.saveSettings.push(structuredClone(settings));
        return { ok: true };
      }),
      onBeforeClose: vi.fn(),
    },
  };
}

async function loadClient(loadResult) {
  const fake = fakeBridge(loadResult);
  window.taskflow = { storage: fake.bridge };
  vi.resetModules();
  const client = await import('../../src/storage/storage.js');
  return { client, ...fake };
}

const loaded = (overrides = {}) => ({
  status: 'loaded',
  writable: true,
  settings: { language: 'en', lastView: { destination: '__all__', layout: 'list' } },
  categories: [],
  tasks: [],
  ...overrides,
});

describe('renderer storage client', () => {
  afterEach(() => {
    delete window.taskflow;
  });

  it('returns boot data including the remembered view and registers the close flush', async () => {
    const { client, bridge } = await loadClient(loaded());
    const boot = await client.loadAppData();
    expect(boot).toMatchObject({ status: 'loaded', writable: true, language: 'en', tasks: [], categories: [] });
    expect(boot.lastView).toEqual({ destination: '__all__', layout: 'list' });
    expect(bridge.onBeforeClose).toHaveBeenCalledWith(client.flushSaves);
  });

  it('sends language and view changes as one merged settings snapshot', async () => {
    const { client, calls } = await loadClient(loaded());
    await client.loadAppData();
    client.saveLastView({ destination: 'cat-1', layout: 'board' });
    client.saveLanguage('ru');
    await client.flushSaves();
    expect(calls.saveSettings.at(-1)).toEqual({ language: 'ru', lastView: { destination: 'cat-1', layout: 'board' }, reminders: { enabled: true, allDayTime: '09:00' }, availability: null });
  });

  it('does not write anything when storage is read-only', async () => {
    const { client, bridge } = await loadClient(loaded({ status: 'newer-version', writable: false }));
    await client.loadAppData();
    client.saveBoard({ tasks: [], categories: [] });
    client.saveLanguage('ru');
    await client.flushSaves();
    expect(bridge.saveBoard).not.toHaveBeenCalled();
    expect(bridge.saveSettings).not.toHaveBeenCalled();
  });

  it('reports failed saves and clears the error after a successful retry', async () => {
    const { client, bridge } = await loadClient(loaded());
    await client.loadAppData();
    bridge.saveBoard.mockResolvedValueOnce({ ok: false, code: 'EPERM' });
    client.saveBoard({ tasks: [], categories: [] });
    await client.flushSaves();
    expect(client.getSaveStatus()).toEqual({ ok: false, code: 'EPERM' });
    await client.retrySave();
    expect(client.getSaveStatus()).toEqual({ ok: true });
  });

  it('carries over a legacy localStorage language on first launch', async () => {
    window.localStorage.setItem('taskflow.language', 'en');
    const { client, calls } = await loadClient(loaded({ status: 'new', tasks: null, categories: null, settings: { language: 'ru' } }));
    const boot = await client.loadAppData();
    await client.flushSaves();
    expect(boot.language).toBe('en');
    expect(boot.tasks).toBeNull();
    expect(calls.saveSettings.at(-1)).toMatchObject({ language: 'en' });
  });

  it('treats a failed load as read-only so nothing can overwrite the data', async () => {
    window.taskflow = { storage: { load: async () => { throw new Error('ipc'); }, onBeforeClose: () => {} } };
    vi.resetModules();
    const client = await import('../../src/storage/storage.js');
    const boot = await client.loadAppData();
    expect(boot).toMatchObject({ status: 'read-error', writable: false, tasks: [], categories: [] });
  });

  it('works without the Electron bridge (browser preview) without saving', async () => {
    vi.resetModules();
    const client = await import('../../src/storage/storage.js');
    const boot = await client.loadAppData();
    expect(boot).toMatchObject({ status: 'unavailable', writable: false, tasks: null });
  });
});
