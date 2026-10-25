// @vitest-environment node
// Stage 5 data-integrity checks: storage/renderer agreement, unknown fields, backups that
// cannot be used, full-field migrations and category-name round trips. Temp folders only.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeCategoryName, restoreCategories } from '../../src/data/categoryModel.js';
import { normalizeSubtaskTitle } from '../../src/data/subtasks.js';
import { normalizeLabels, restoreTask } from '../../src/data/taskModel.js';
import { makeCategory, makeDocument, makeTask, V4_SETTINGS_DEFAULTS, V4_TASK_DEFAULTS, v4Fields } from '../helpers/fixtures.js';
import { createTempDir } from '../helpers/tempDir.js';

const require = createRequire(import.meta.url);
const { createStorage, FILE_NAME } = require('../../electron/storage.cjs');
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
const copies = (kind) => temp.list().filter((name) => name.includes(kind));
const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

describe('storage and renderer agree on every value', () => {
  // Values at and beyond the renderer's limits, odd whitespace and impossible dates.
  const awkward = [
    makeTask({ id: 'long', title: `${'Очень длинное название '.repeat(6)}`, description: `  ${'x'.repeat(2100)}  ` }),
    makeTask({ id: 'space-at-cut', title: `${'a'.repeat(119)} tail` }),
    makeTask({ id: 'labels', labels: ['a', 'A', ' b  c ', 'x'.repeat(29) + ' y', ...Array.from({ length: 12 }, (_, i) => `l${i}`)] }),
    makeTask({ id: 'date', dueDate: '2026-02-30' }),
    makeTask({ id: 'leap', dueDate: '2028-02-29' }),
    makeTask({ id: 'sub', subtasks: [{ id: 's', title: `${'п'.repeat(199)} q`, done: true }] }),
  ];

  it('anything the renderer would change is reported as a repair, with a copy of the original', () => {
    temp.writeJson(FILE_NAME, makeDocument({ tasks: awkward }));
    const original = fs.readFileSync(temp.file(FILE_NAME), 'utf8');
    const { result } = open();
    expect(result.status).toBe('repaired');
    expect(fs.readFileSync(temp.file(copies('before-repair')[0]), 'utf8')).toBe(original);
    const byId = Object.fromEntries(result.tasks.map((task) => [task.id, task]));
    expect(byId.long.title.length).toBeLessThanOrEqual(120);
    expect(byId.long.description).toHaveLength(2000);
    expect(byId['space-at-cut'].title).toBe('a'.repeat(119));
    expect(byId.labels.labels).toEqual(normalizeLabels(awkward[2].labels));
    expect(byId.date.dueDate).toBeNull();
    expect(byId.leap.dueDate).toBe('2028-02-29');
    expect(byId.sub.subtasks[0].title).toBe('п'.repeat(199));
  });

  it('after loading, the renderer changes nothing (so no save can alter data silently)', () => {
    temp.writeJson(FILE_NAME, makeDocument({ tasks: awkward, categories: [makeCategory({ id: 'c', name: `${'Категория '.repeat(6)}`, order: 0 })] }));
    const { result } = open();
    for (const task of result.tasks) expect(without(restoreTask(task), 'order')).toEqual(without(task, 'order'));
    expect(restoreCategories(result.categories).map((category) => category.name)).toEqual(result.categories.map((category) => category.name));
    // Normalization is idempotent on both sides.
    for (const value of ['  a  b  ', `${'я'.repeat(59)} z`, '\tx\n']) {
      expect(normalizeCategoryName(normalizeCategoryName(value))).toBe(normalizeCategoryName(value));
      expect(normalizeSubtaskTitle(normalizeSubtaskTitle(value))).toBe(normalizeSubtaskTitle(value));
    }
  });

  it('a clean file stays clean: no repair, no copy, and saving it back changes nothing', () => {
    const doc = makeDocument({
      categories: [makeCategory({ id: 'c', name: 'Work & Life — 2026 (Q4)!', order: 0 })],
      tasks: [makeTask({ id: 'a', title: 'Полный', description: 'Описание\nв две строки', priority: 'high', dueDate: '2026-12-31', labels: ['Метка', 'tag'], status: 'inProgress', categoryId: 'c', subtasks: [{ id: 's1', title: 'Шаг', done: true }] })],
    });
    temp.writeJson(FILE_NAME, doc);
    const { storage, result } = open();
    expect(result.status).toBe('loaded');
    expect(temp.list()).toEqual([FILE_NAME]);
    storage.saveBoard({ tasks: result.tasks.map(restoreTask), categories: restoreCategories(result.categories) });
    const saved = temp.readJson(FILE_NAME);
    expect(saved.tasks).toEqual(doc.tasks);
    expect(saved.categories).toEqual(doc.categories);
  });
});

describe('unknown fields are never dropped silently', () => {
  it.each([
    ['task', (doc) => ({ ...doc, tasks: [{ ...doc.tasks[0], estimate: 3 }] })],
    ['category', (doc) => ({ ...doc, categories: [{ ...doc.categories[0], color: 'red' }] })],
    ['settings', (doc) => ({ ...doc, settings: { ...doc.settings, theme: 'dark' } })],
    ['last view', (doc) => ({ ...doc, settings: { ...doc.settings, lastView: { destination: '__all__', layout: 'board', zoom: 2 } } })],
    ['document', (doc) => ({ ...doc, sync: { device: 'x' } })],
  ])('an unknown %s field makes the load a repair and keeps the original file', (_, mutate) => {
    const base = makeDocument({ categories: [makeCategory({ id: 'c', name: 'C', order: 0 })], tasks: [makeTask({ id: 't', categoryId: 'c' })] });
    temp.writeJson(FILE_NAME, mutate(base));
    const original = fs.readFileSync(temp.file(FILE_NAME), 'utf8');
    const { storage, result } = open();
    expect(result.status).toBe('repaired');
    const [copy] = copies('before-repair');
    expect(fs.readFileSync(temp.file(copy), 'utf8')).toBe(original);
    // The copy survives any number of later saves (backups rotate, preserved copies do not).
    for (let i = 0; i < 3; i += 1) storage.saveBoard({ tasks: result.tasks, categories: result.categories });
    expect(fs.readFileSync(temp.file(copy), 'utf8')).toBe(original);
  });
});

describe('a backup that cannot be used is preserved before it can be overwritten', () => {
  it('main file corrupt, backup written by a newer version: the backup is kept byte-for-byte', () => {
    const newer = JSON.stringify({ schemaVersion: 9, tasks: [makeTask({ title: 'Только в бэкапе' })] });
    temp.writeText(FILE_NAME, '{ broken');
    temp.writeText(BACKUP, newer);
    const { storage, result } = open();
    expect(result.status).toBe('unreadable');
    expect(result.preservedBackup).toBeTruthy();
    for (let i = 0; i < 3; i += 1) expect(storage.saveBoard({ tasks: [], categories: [] }).ok).toBe(true);
    expect(fs.readFileSync(result.preservedBackup, 'utf8')).toBe(newer);
    expect(copies('unreadable-')).toHaveLength(1);
  });

  it('main file missing, backup damaged: reported (not a first launch with samples) and kept', () => {
    const damaged = '{"schemaVersion":3,"tasks":[{"id":"x","title":"Почти целый"}';
    temp.writeText(BACKUP, damaged);
    const { storage, result } = open();
    expect(result.status).toBe('unreadable');
    expect(result.tasks).toEqual([]);
    for (let i = 0; i < 3; i += 1) storage.saveBoard({ tasks: [], categories: [] });
    expect(fs.readFileSync(result.preservedCopy, 'utf8')).toBe(damaged);
  });

  it('a usable backup is still recovered as before (no extra copies)', () => {
    temp.writeText(FILE_NAME, '{ broken');
    temp.writeJson(BACKUP, makeDocument({ tasks: [makeTask({ id: 'b', title: 'Из бэкапа' })] }));
    const { result } = open();
    expect(result.status).toBe('recovered');
    expect(result.tasks.map((task) => task.title)).toEqual(['Из бэкапа']);
    expect(copies('unusable-backup')).toEqual([]);
  });
});

describe('full-field migrations', () => {
  const v1Task = {
    id: 'id-1', title: 'Отчёт', description: 'Детали', priority: 'high', dueDate: '2026-11-30',
    labels: ['Работа', 'Q4'], status: 'inProgress', order: 2, createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-02-03T04:05:06.000Z',
  };

  it('v1 → v3 keeps every field and setting, and a second launch is clean', () => {
    temp.writeJson(FILE_NAME, { schemaVersion: 1, savedAt: '2026-01-01T00:00:00.000Z', settings: { language: 'en' }, tasks: [v1Task, { ...v1Task, id: 'id-2', order: 0, status: 'done', dueDate: null, labels: [] }] });
    const first = open();
    expect(first.result.status).toBe('migrated');
    expect(first.result.tasks).toEqual([
      { ...v1Task, categoryId: null, subtasks: [], ...v4Fields(v1Task) },
      { ...v1Task, id: 'id-2', order: 0, status: 'done', dueDate: null, labels: [], categoryId: null, subtasks: [], ...V4_TASK_DEFAULTS, completedAt: v1Task.updatedAt },
    ]);
    expect(first.result.settings.language).toBe('en');
    // The renderer saves migrated data at once; the next launch is a clean load.
    first.storage.saveBoard({ tasks: first.result.tasks, categories: first.result.categories });
    const second = open();
    expect(second.result.status).toBe('loaded');
    expect(second.result.tasks).toEqual(first.result.tasks);
    expect(copies('before-migration')).toHaveLength(1);
  });

  it('v2 → v3 keeps categories, assignments, order and the remembered view', () => {
    const v2 = {
      schemaVersion: 2,
      settings: { language: 'ru', lastView: { destination: 'cat-b', layout: 'list' } },
      categories: [{ id: 'cat-a', name: 'Дом', order: 1, createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'cat-b', name: 'Work', order: 0, createdAt: '2026-01-01T00:00:00.000Z' }],
      tasks: [{ ...v1Task, categoryId: 'cat-b' }, { ...v1Task, id: 'id-2', categoryId: null }],
    };
    temp.writeJson(FILE_NAME, v2);
    const { result } = open();
    expect(result.status).toBe('migrated');
    expect(result.categories).toEqual(v2.categories);
    expect(result.tasks).toEqual(v2.tasks.map((task) => ({ ...task, subtasks: [], ...v4Fields(task) })));
    expect(result.settings).toEqual({ ...v2.settings, ...V4_SETTINGS_DEFAULTS });
  });

  it('migration is repeatable: migrating the same v2 file twice gives identical results', () => {
    const v2 = { schemaVersion: 2, settings: { language: 'ru' }, categories: [], tasks: [{ ...v1Task, categoryId: null }] };
    temp.writeJson(FILE_NAME, v2);
    const first = open().result;
    const again = createTempDir();
    try {
      again.writeJson(FILE_NAME, v2);
      expect(createStorage(again.dir).load().tasks).toEqual(first.tasks);
    } finally {
      again.remove();
    }
  });
});

describe('category names round-trip', () => {
  const names = ['Work & Life — 2026 (Q4)!', 'Дом/Сад, «Дача»', 'Ёлки-палки: v2.0?', 'Mixed Смешанная 123', 'a', 'Я'.repeat(60)];

  it('names with spaces, Latin, Cyrillic and punctuation survive save and reload unchanged', () => {
    const { storage } = open();
    const categories = names.map((name, order) => makeCategory({ id: `c${order}`, name, order }));
    expect(storage.saveBoard({ tasks: [], categories }).ok).toBe(true);
    const reloaded = open().result;
    expect(reloaded.status).toBe('loaded');
    expect(reloaded.categories.map((category) => category.name)).toEqual(names);
    expect(restoreCategories(reloaded.categories).map((category) => category.name)).toEqual(names);
  });

  it('extra whitespace is collapsed the same way on both sides', () => {
    const { storage } = open();
    storage.saveBoard({ tasks: [], categories: [makeCategory({ id: 'c', name: '  Work   &\tLife  ', order: 0 })] });
    expect(open().result.categories[0].name).toBe(normalizeCategoryName('  Work   &\tLife  '));
    expect(normalizeCategoryName('  Work   &\tLife  ')).toBe('Work & Life');
  });
});
