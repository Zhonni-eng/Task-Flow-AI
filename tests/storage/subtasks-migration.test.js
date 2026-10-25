// @vitest-environment node
// Schema v3 (subtasks): migration from v2/v1, validation, repair and round-trips.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCategory, makeDocument, makeTask, V4_SETTINGS_DEFAULTS } from '../helpers/fixtures.js';
import { createTempDir } from '../helpers/tempDir.js';

const require = createRequire(import.meta.url);
const { createStorage, FILE_NAME } = require('../../electron/storage.cjs');

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
const withoutSubtasks = ({ subtasks, ...task }) => task;

describe('v2 → v3 migration', () => {
  const v2 = () => ({
    schemaVersion: 2,
    savedAt: '2026-10-20T00:00:00.000Z',
    settings: { language: 'en', lastView: { destination: 'c1', layout: 'list' } },
    categories: [makeCategory({ id: 'c1', name: 'Работа' })],
    tasks: [
      withoutSubtasks(makeTask({ id: 't1', title: 'A', labels: ['x'], dueDate: '2026-11-15', priority: 'high', status: 'inProgress', order: 1, categoryId: 'c1' })),
      withoutSubtasks(makeTask({ id: 't2', title: 'B', order: 0 })),
    ],
  });

  it('adds an empty subtask list and preserves every other field, setting and category', () => {
    const original = v2();
    temp.writeJson(FILE_NAME, original);
    const { result } = open();
    expect(result.status).toBe('migrated');
    expect(result.tasks).toEqual(original.tasks.map((task) => ({ ...task, subtasks: [] })));
    expect(result.categories).toEqual(original.categories);
    expect(result.settings).toEqual({ ...original.settings, ...V4_SETTINGS_DEFAULTS });
  });

  it('keeps the original v2 file byte-for-byte and writes v3 on the next save', () => {
    temp.writeJson(FILE_NAME, v2());
    const before = fs.readFileSync(temp.file(FILE_NAME), 'utf8');
    const { storage, result } = open();
    const copy = temp.list().find((name) => name.includes('before-migration'));
    expect(fs.readFileSync(temp.file(copy), 'utf8')).toBe(before);
    storage.saveBoard({ tasks: result.tasks, categories: result.categories });
    const saved = temp.readJson(FILE_NAME);
    expect(saved.schemaVersion).toBe(4);
    expect(saved.tasks.every((task) => Array.isArray(task.subtasks))).toBe(true);
  });

  it('is repeatable: data that already has subtasks keeps them, and a second load is clean', () => {
    const document = v2();
    document.tasks[0].subtasks = [{ id: 's1', title: 'Keep me', done: true }];
    temp.writeJson(FILE_NAME, document);
    const first = open();
    expect(first.result.tasks[0].subtasks).toEqual([{ id: 's1', title: 'Keep me', done: true }]);
    first.storage.saveBoard({ tasks: first.result.tasks, categories: first.result.categories });
    const second = open();
    expect(second.result.status).toBe('loaded');
    expect(second.result.tasks[0].subtasks).toEqual([{ id: 's1', title: 'Keep me', done: true }]);
  });

  it('upgrades v1 data through v2 to v3', () => {
    temp.writeJson(FILE_NAME, { schemaVersion: 1, settings: { language: 'ru' }, tasks: [withoutSubtasks({ ...makeTask({ id: 'old' }), categoryId: undefined })] });
    const { result } = open();
    expect(result.status).toBe('migrated');
    expect(result.tasks[0]).toMatchObject({ id: 'old', categoryId: null, subtasks: [] });
  });
});

describe('v3 subtask validation', () => {
  it('round-trips subtasks exactly, keeping their order and parent', () => {
    const tasks = [
      makeTask({ id: 'p', subtasks: [{ id: 'a', title: 'Первая', done: true }, { id: 'b', title: 'Вторая', done: false }] }),
      makeTask({ id: 'q' }),
    ];
    open().storage.saveBoard({ tasks, categories: [] });
    const { result } = open();
    expect(result.status).toBe('loaded');
    expect(result.tasks).toEqual(tasks);
  });

  it('repairs invalid subtasks without touching valid data, keeping a copy of the original', () => {
    temp.writeJson(
      FILE_NAME,
      makeDocument({
        tasks: [
          makeTask({
            id: 'p',
            subtasks: [
              { id: 'a', title: '  Нормальная  ', done: true },
              { id: 'a', title: 'duplicate id', done: false },
              { title: 'no id' },
              { id: 'c', title: '   ' },
              { id: 'd', title: 'Nested', done: 'yes', subtasks: [{ id: 'x', title: 'deep' }] },
              'garbage',
            ],
          }),
          makeTask({ id: 'q', subtasks: 'not a list' }),
        ],
      }),
    );
    const { result } = open();
    expect(result.status).toBe('repaired');
    expect(result.tasks[0].subtasks).toEqual([
      { id: 'a', title: 'Нормальная', done: true },
      { id: 'd', title: 'Nested', done: false },
    ]);
    expect(result.tasks[1].subtasks).toEqual([]);
    expect(temp.list().some((name) => name.includes('before-repair'))).toBe(true);
  });

  // Regression: the whitespace regex once lost its backslash and matched the letter "s".
  it('keeps titles and category names that contain the letter "s" intact (only whitespace is collapsed)', () => {
    const categories = [makeCategory({ id: 'c1', name: 'Business tasks' })];
    const tasks = [makeTask({ id: 'p', categoryId: 'c1', subtasks: [{ id: 'a', title: 'Ship the  release   notes', done: false }] })];
    const { storage } = open();
    storage.saveBoard({ tasks, categories });
    const { result } = open();
    expect(result.status).toBe('loaded');
    expect(result.categories[0].name).toBe('Business tasks');
    expect(result.tasks[0].subtasks[0].title).toBe('Ship the release notes');
  });

  it('loads an existing category whose name contains "s" without a repair', () => {
    temp.writeJson(FILE_NAME, makeDocument({ categories: [makeCategory({ id: 'c1', name: 'Personal stuff' })] }));
    const { result } = open();
    expect(result.status).toBe('loaded');
    expect(result.categories[0].name).toBe('Personal stuff');
  });

  it('saveBoard strips unknown subtask fields and nesting', () => {
    const { storage } = open();
    storage.saveBoard({ tasks: [makeTask({ id: 'p', subtasks: [{ id: 'a', title: 'A', done: true, secret: 1, subtasks: [{ id: 'z', title: 'Z' }] }] })], categories: [] });
    expect(temp.readJson(FILE_NAME).tasks[0].subtasks).toEqual([{ id: 'a', title: 'A', done: true }]);
  });

  it('opens data from a newer schema read-only so subtasks can never be dropped by an older build', () => {
    const future = JSON.stringify({ schemaVersion: 99, tasks: [] });
    temp.writeText(FILE_NAME, future);
    const { storage, result } = open();
    expect(result).toMatchObject({ status: 'newer-version', writable: false });
    expect(storage.saveBoard({ tasks: [], categories: [] }).ok).toBe(false);
    expect(fs.readFileSync(temp.file(FILE_NAME), 'utf8')).toBe(future);
  });
});
