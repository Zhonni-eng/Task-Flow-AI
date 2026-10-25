// @vitest-environment node
// Main-process JSON storage (electron/storage.cjs), always in isolated temp folders.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCategory, makeDocument, makeTask, V4_SETTINGS_DEFAULTS, v4Fields } from '../helpers/fixtures.js';
import { createTempDir } from '../helpers/tempDir.js';

const require = createRequire(import.meta.url);
const { createStorage, FILE_NAME, SCHEMA_VERSION } = require('../../electron/storage.cjs');
const BACKUP = `${FILE_NAME}.bak`;

let temp;
beforeEach(() => {
  temp = createTempDir();
});
afterEach(() => {
  temp.remove();
});

const open = () => {
  const storage = createStorage(temp.dir);
  return { storage, result: storage.load() };
};

describe('initial storage', () => {
  it('reports a first launch without writing anything', () => {
    const { result } = open();
    expect(result).toMatchObject({ status: 'new', writable: true, tasks: null, categories: null });
    expect(result.settings).toEqual({ language: 'ru', lastView: { destination: '__all__', layout: 'board' }, ...V4_SETTINGS_DEFAULTS });
    expect(temp.list()).toEqual([]);
  });

  it('creates the folder when it does not exist', () => {
    const nested = path.join(temp.dir, 'a', 'b');
    createStorage(nested).load();
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('uses the current schema version', () => {
    expect(SCHEMA_VERSION).toBe(4);
  });
});

describe('saving and loading', () => {
  it('round-trips tasks, categories and settings exactly', () => {
    const category = makeCategory({ id: 'c1', name: 'Работа' });
    const task = makeTask({ id: 't1', labels: ['A', 'Б'], dueDate: '2026-11-15', priority: 'high', status: 'done', order: 3, categoryId: 'c1' });
    const { storage } = open();
    expect(storage.saveBoard({ tasks: [task], categories: [category] }).ok).toBe(true);
    expect(storage.saveSettings({ language: 'en', lastView: { destination: 'c1', layout: 'list' } }).ok).toBe(true);

    const { result } = open();
    expect(result.status).toBe('loaded');
    expect(result.tasks).toEqual([task]);
    expect(result.categories).toEqual([category]);
    expect(result.settings).toEqual({ language: 'en', lastView: { destination: 'c1', layout: 'list' }, ...V4_SETTINGS_DEFAULTS });
    expect(temp.readJson(FILE_NAME).schemaVersion).toBe(4);
  });

  it('persists an empty task list (no re-seeding of sample data)', () => {
    open().storage.saveBoard({ tasks: [], categories: [] });
    expect(open().result).toMatchObject({ status: 'loaded', tasks: [] });
  });

  it('rejects invalid input', () => {
    const { storage } = open();
    expect(storage.saveBoard(null).ok).toBe(false);
    expect(storage.saveBoard({ tasks: [] }).ok).toBe(false);
    expect(storage.saveBoard({ tasks: 'x', categories: [] }).ok).toBe(false);
    expect(storage.saveSettings({ language: 'de' }).ok).toBe(false);
    expect(storage.saveSettings(null).ok).toBe(false);
  });

  it('strips unknown fields from saved tasks', () => {
    const { storage } = open();
    storage.saveBoard({ tasks: [{ ...makeTask({ id: 't' }), secret: 'x', __proto__hack: 1 }], categories: [] });
    expect(Object.keys(temp.readJson(FILE_NAME).tasks[0])).not.toContain('secret');
  });

  it('keeps the previous save as a backup', () => {
    const { storage } = open();
    storage.saveBoard({ tasks: [makeTask({ id: 'first' })], categories: [] });
    storage.saveBoard({ tasks: [makeTask({ id: 'second' })], categories: [] });
    expect(temp.readJson(BACKUP).tasks.map((task) => task.id)).toEqual(['first']);
    expect(temp.readJson(FILE_NAME).tasks.map((task) => task.id)).toEqual(['second']);
  });
});

describe('settings', () => {
  it('updates language and last view independently', () => {
    const { storage } = open();
    storage.saveBoard({ tasks: [], categories: [makeCategory({ id: 'c1' })] });
    storage.saveSettings({ lastView: { destination: '__uncategorized__', layout: 'list' } });
    storage.saveSettings({ language: 'en' });
    expect(open().result.settings).toEqual({ language: 'en', lastView: { destination: '__uncategorized__', layout: 'list' }, ...V4_SETTINGS_DEFAULTS });
  });

  it('falls back to All tasks + Board for missing or invalid last view (no repair notice)', () => {
    temp.writeJson(FILE_NAME, makeDocument({ settings: { language: 'en', lastView: { destination: 'ghost', layout: 'grid' } } }));
    const { result } = open();
    expect(result.status).toBe('loaded');
    expect(result.settings.lastView).toEqual({ destination: '__all__', layout: 'board' });
  });

  it('resets the remembered category when that category is deleted', () => {
    const { storage } = open();
    storage.saveBoard({ tasks: [], categories: [makeCategory({ id: 'c1' })] });
    storage.saveSettings({ lastView: { destination: 'c1', layout: 'list' } });
    storage.saveBoard({ tasks: [], categories: [] });
    expect(open().result.settings.lastView).toEqual({ destination: '__all__', layout: 'list' });
  });
});

describe('migration', () => {
  const v1Tasks = [
    { id: 'keep-1', title: 'Первая', description: 'описание', priority: 'high', dueDate: '2026-12-01', labels: ['Метка'], status: 'todo', order: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' },
    { id: 'keep-0', title: 'Нулевая', description: '', priority: 'low', dueDate: null, labels: [], status: 'done', order: 0, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
  ];

  it('upgrades v1 data to the current version without losing ids, order, labels, dates or settings', () => {
    temp.writeJson(FILE_NAME, { schemaVersion: 1, savedAt: 'x', settings: { language: 'en' }, tasks: v1Tasks });
    const { result } = open();
    expect(result.status).toBe('migrated');
    expect(result.tasks).toEqual(v1Tasks.map((task) => ({ ...task, categoryId: null, subtasks: [], ...v4Fields(task) })));
    expect(result.categories).toEqual([]);
    expect(result.settings.language).toBe('en');
    expect(result.settings.lastView).toEqual({ destination: '__all__', layout: 'board' });
    expect(temp.list().some((name) => name.includes('before-migration'))).toBe(true);
  });

  it('upgrades unversioned data (bare task array)', () => {
    temp.writeJson(FILE_NAME, v1Tasks);
    const { result } = open();
    expect(result.status).toBe('migrated');
    expect(result.tasks.map((task) => task.id)).toEqual(['keep-1', 'keep-0']);
    expect(result.settings.language).toBe('ru');
  });

  it('upgrades an unversioned object with tasks and settings', () => {
    temp.writeJson(FILE_NAME, { tasks: v1Tasks, settings: { language: 'en' } });
    expect(open().result).toMatchObject({ status: 'migrated', settings: { language: 'en' } });
  });

  it('writes the new format on the next save, keeping the original copy', () => {
    temp.writeJson(FILE_NAME, { schemaVersion: 1, settings: { language: 'en' }, tasks: v1Tasks });
    const { storage, result } = open();
    storage.saveBoard({ tasks: result.tasks, categories: [] });
    const saved = temp.readJson(FILE_NAME);
    expect(saved.schemaVersion).toBe(4);
    expect(saved.tasks.every((task) => task.categoryId === null && Array.isArray(task.subtasks) && task.subtasks.length === 0)).toBe(true);
    const copy = temp.list().find((name) => name.includes('before-migration'));
    expect(temp.readJson(copy).schemaVersion).toBe(1);
  });

  it('opens data from a newer version read-only and never overwrites it', () => {
    const future = JSON.stringify({ schemaVersion: 99, tasks: [] });
    temp.writeText(FILE_NAME, future);
    const { storage, result } = open();
    expect(result).toMatchObject({ status: 'newer-version', writable: false });
    expect(storage.saveBoard({ tasks: [makeTask()], categories: [] })).toEqual({ ok: false, code: 'READ_ONLY' });
    expect(storage.saveSettings({ language: 'en' })).toEqual({ ok: false, code: 'READ_ONLY' });
    expect(fs.readFileSync(temp.file(FILE_NAME), 'utf8')).toBe(future);
  });
});

describe('corruption and recovery', () => {
  it('recovers from the backup and keeps the corrupt file byte-for-byte', () => {
    const { storage } = open();
    storage.saveBoard({ tasks: [makeTask({ id: 'good' })], categories: [] });
    storage.saveBoard({ tasks: [makeTask({ id: 'good' }), makeTask({ id: 'newer' })], categories: [] });
    temp.writeText(FILE_NAME, '{ broken json');

    const reopened = open();
    expect(reopened.result.status).toBe('recovered');
    expect(reopened.result.tasks.map((task) => task.id)).toEqual(['good']);
    const copy = temp.list().find((name) => name.includes('unreadable'));
    expect(fs.readFileSync(temp.file(copy), 'utf8')).toBe('{ broken json');

    // The corrupt file must never replace the good backup.
    reopened.storage.saveBoard({ tasks: [makeTask({ id: 'good' })], categories: [] });
    expect(temp.readJson(BACKUP).tasks[0].id).toBe('good');
  });

  it('loads a file that starts with a UTF-8 byte-order mark', () => {
    temp.writeText(FILE_NAME, `﻿${JSON.stringify(makeDocument({ tasks: [makeTask({ id: 'bom' })] }))}`);
    expect(open().result).toMatchObject({ status: 'loaded', tasks: [expect.objectContaining({ id: 'bom' })] });
  });

  it('opens an empty board when the file is corrupt and there is no backup', () => {
    temp.writeText(FILE_NAME, 'garbage');
    const { result } = open();
    expect(result).toMatchObject({ status: 'unreadable', writable: true, tasks: [] });
    expect(result.preservedCopy).toEqual(expect.stringContaining('unreadable'));
  });

  it('recovers when the main file is missing but a backup exists', () => {
    temp.writeJson(BACKUP, makeDocument({ tasks: [makeTask({ id: 'b' })] }));
    expect(open().result).toMatchObject({ status: 'recovered', tasks: [expect.objectContaining({ id: 'b' })] });
  });

  it('repairs invalid records, keeps valid ones and preserves the original', () => {
    temp.writeJson(
      FILE_NAME,
      makeDocument({
        tasks: [
          makeTask({ id: 'ok' }),
          { title: 'no id' },
          makeTask({ id: 'bad', priority: 'urgent', dueDate: 'tomorrow', labels: ['x', 5], status: 'archived' }),
          makeTask({ id: 'ok' }),
        ],
      }),
    );
    const { result } = open();
    expect(result.status).toBe('repaired');
    expect(result.dropped).toBe(2);
    expect(result.tasks.find((task) => task.id === 'bad')).toMatchObject({ priority: 'medium', dueDate: null, labels: ['x'], status: 'todo' });
    expect(temp.list().some((name) => name.includes('before-repair'))).toBe(true);
  });

  it('drops invalid categories and detaches tasks from unknown categories', () => {
    temp.writeJson(
      FILE_NAME,
      makeDocument({
        categories: [{ id: 'c1', name: '  A ' }, { id: 'c1', name: 'dup id' }, { id: 'c3', name: 'a' }, { name: 'no id' }, { id: 'c4', name: '' }],
        tasks: [makeTask({ id: 't1', categoryId: 'c3' }), makeTask({ id: 't2', categoryId: 'c1' })],
      }),
    );
    const { result } = open();
    expect(result.status).toBe('repaired');
    expect(result.categories.map((category) => [category.id, category.name])).toEqual([['c1', 'A']]);
    expect(result.tasks.map((task) => task.categoryId)).toEqual([null, 'c1']);
  });

  it('saveBoard detaches tasks that point at a missing category', () => {
    const { storage } = open();
    storage.saveBoard({ tasks: [makeTask({ id: 't', categoryId: 'ghost' })], categories: [] });
    expect(temp.readJson(FILE_NAME).tasks[0].categoryId).toBeNull();
  });
});

describe('write safety', () => {
  it('leaves no temp file behind and keeps valid JSON after every save', () => {
    const { storage } = open();
    for (let i = 0; i < 5; i += 1) storage.saveBoard({ tasks: [makeTask({ id: `t${i}` })], categories: [] });
    expect(temp.list()).toEqual([FILE_NAME, BACKUP]);
    expect(() => temp.readJson(FILE_NAME)).not.toThrow();
  });

  it('reports a failed save, keeps the previous file intact and recovers on retry', () => {
    const { storage } = open();
    storage.saveBoard({ tasks: [makeTask({ id: 'one' })], categories: [] });
    const before = fs.readFileSync(temp.file(FILE_NAME), 'utf8');

    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    const failed = storage.saveBoard({ tasks: [makeTask({ id: 'one' }), makeTask({ id: 'two' })], categories: [] });
    rename.mockRestore();

    expect(failed).toEqual({ ok: false, code: 'ENOSPC' });
    expect(fs.readFileSync(temp.file(FILE_NAME), 'utf8')).toBe(before);
    expect(temp.list()).not.toContain(`${FILE_NAME}.tmp`);

    expect(storage.saveBoard({ tasks: [makeTask({ id: 'one' }), makeTask({ id: 'two' })], categories: [] }).ok).toBe(true);
    expect(open().result.tasks).toHaveLength(2);
  });

  it('a save failure keeps the in-memory state at the last successful save', () => {
    const { storage } = open();
    storage.saveBoard({ tasks: [makeTask({ id: 'kept' })], categories: [] });
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('locked'), { code: 'EACCES' });
    });
    storage.saveBoard({ tasks: [], categories: [] });
    rename.mockRestore();
    expect(storage.load().tasks.map((task) => task.id)).toEqual(['kept']);
  });

  it('retries a briefly locked file (Windows EBUSY) and then succeeds', () => {
    const { storage } = open();
    const real = fs.renameSync;
    let attempts = 0;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return real(from, to);
    });
    expect(storage.saveBoard({ tasks: [makeTask({ id: 'x' })], categories: [] }).ok).toBe(true);
    rename.mockRestore();
    expect(attempts).toBe(3);
  });
});

describe('reload freshness', () => {
  it('a second load() in the same session returns the latest data, not the startup snapshot', () => {
    const { storage } = open();
    storage.saveBoard({ tasks: [makeTask({ id: 'a' }), makeTask({ id: 'b' })], categories: [makeCategory({ id: 'c' })] });
    storage.saveSettings({ language: 'en' });
    const again = storage.load();
    expect(again).toMatchObject({ status: 'loaded', settings: { language: 'en' } });
    expect(again.tasks.map((task) => task.id)).toEqual(['a', 'b']);
    expect(again.categories).toHaveLength(1);
  });

  it('keeps a read-only status on reload', () => {
    temp.writeText(FILE_NAME, JSON.stringify({ schemaVersion: 99, tasks: [] }));
    const { storage } = open();
    expect(storage.load().status).toBe('newer-version');
  });
});
