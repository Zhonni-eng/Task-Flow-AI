// Save status shown to the user: a success of one kind of save must never hide a failure of the other.
import { afterEach, describe, expect, it, vi } from 'vitest';

function scriptedBridge() {
  const next = { saveBoard: [], saveSettings: [] };
  const answer = (kind) => async () => next[kind].shift() ?? { ok: true };
  return {
    next,
    bridge: {
      load: vi.fn(async () => ({ status: 'loaded', writable: true, settings: { language: 'ru' }, categories: [], tasks: [] })),
      saveBoard: vi.fn(answer('saveBoard')),
      saveSettings: vi.fn(answer('saveSettings')),
      onBeforeClose: vi.fn(),
    },
  };
}

async function start() {
  const fake = scriptedBridge();
  window.taskflow = { storage: fake.bridge };
  vi.resetModules();
  const client = await import('../../src/storage/storage.js');
  await client.loadAppData();
  const seen = [];
  client.subscribeSaveStatus((status) => seen.push(status));
  return { client, ...fake, seen };
}

describe('save status', () => {
  afterEach(() => {
    delete window.taskflow;
  });

  it('a failed settings save stays visible after a later successful board save', async () => {
    const { client, next } = await start();
    next.saveSettings.push({ ok: false, code: 'EPERM' });
    client.saveLanguage('en');
    await client.flushSaves();
    expect(client.getSaveStatus()).toEqual({ ok: false, code: 'EPERM' });
    client.saveBoard({ tasks: [], categories: [] });
    await client.flushSaves();
    expect(client.getSaveStatus()).toEqual({ ok: false, code: 'EPERM' });
  });

  it('a failed board save stays visible after a later successful settings save', async () => {
    const { client, next } = await start();
    next.saveBoard.push({ ok: false, code: 'ENOSPC' });
    client.saveBoard({ tasks: [], categories: [] });
    await client.flushSaves();
    client.saveLanguage('en');
    await client.flushSaves();
    expect(client.getSaveStatus()).toEqual({ ok: false, code: 'ENOSPC' });
  });

  it('clears only when every failed save has succeeded again (retry)', async () => {
    const { client, next, bridge, seen } = await start();
    next.saveBoard.push({ ok: false, code: 'EBUSY' });
    next.saveSettings.push({ ok: false, code: 'EPERM' });
    client.saveBoard({ tasks: [{ id: 'x' }], categories: [] });
    client.saveLanguage('en');
    await client.flushSaves();
    expect(client.getSaveStatus().ok).toBe(false);
    await client.retrySave();
    expect(client.getSaveStatus()).toEqual({ ok: true });
    // The retry re-sent the latest snapshots.
    expect(bridge.saveBoard).toHaveBeenLastCalledWith({ tasks: [{ id: 'x' }], categories: [] });
    expect(bridge.saveSettings).toHaveBeenLastCalledWith({ language: 'en', reminders: { enabled: true, allDayTime: '09:00' }, availability: null });
    expect(seen.at(-1)).toEqual({ ok: true });
  });

  it('a settings save that succeeds on its own clears its earlier failure', async () => {
    const { client, next } = await start();
    next.saveSettings.push({ ok: false, code: 'EPERM' });
    client.saveLanguage('en');
    await client.flushSaves();
    client.saveLanguage('ru');
    await client.flushSaves();
    expect(client.getSaveStatus()).toEqual({ ok: true });
  });

  it('IPC errors and missing results count as failures, never as success', async () => {
    const { client, bridge } = await start();
    bridge.saveBoard.mockRejectedValueOnce(new Error('channel closed'));
    client.saveBoard({ tasks: [], categories: [] });
    await client.flushSaves();
    expect(client.getSaveStatus()).toEqual({ ok: false, code: 'IPC_FAILED' });
    bridge.saveBoard.mockResolvedValueOnce(undefined);
    client.saveBoard({ tasks: [], categories: [] });
    await client.flushSaves();
    expect(client.getSaveStatus()).toEqual({ ok: false, code: 'NO_RESULT' });
  });
});
