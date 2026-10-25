// Main-process persistence: a versioned JSON document in the per-user app data folder.
//
// File layout (in `dir`, normally app.getPath('userData')):
//   taskflow-data.json        current data
//   taskflow-data.json.bak    previous successful save
//   taskflow-data.json.tmp    write in progress (atomic replace)
//   taskflow-data.<reason>-<timestamp>.json   preserved copies of unreadable/repaired data
//
// Writes are synchronous and atomic (temp file + fsync + rename), so the main process
// never interleaves writes and a crash mid-write cannot corrupt the current file.
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_ALL_DAY_REMINDER_TIME,
  isTimeKey,
  normalizeDueTime,
  normalizeEstimate,
  normalizeRecurrence,
  normalizeReminders,
} = require('./shared/schedule.mjs');

const SCHEMA_VERSION = 4;
const FILE_NAME = 'taskflow-data.json';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TASKS = 5000;
const MAX_CATEGORIES = 200;
const MAX_CATEGORY_NAME = 60;
const MAX_SUBTASKS = 100;
const MAX_SUBTASK_TITLE = 200;

const LANGUAGES = ['ru', 'en'];
const DEFAULT_LANGUAGE = 'ru';
const STATUSES = ['todo', 'inProgress', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];

// Last selected view (optional setting; missing or invalid values fall back to the default).
const LAYOUTS = ['board', 'list'];
const ALL_TASKS = '__all__';
const UNCATEGORIZED = '__uncategorized__';
const DEFAULT_LAST_VIEW = Object.freeze({ destination: ALL_TASKS, layout: 'board' });
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

// Task limits and normalization mirror the renderer (src/data/taskModel.js, subtasks.js,
// categoryModel.js). Anything the renderer would change on its next save is detected here
// at load time instead, so the file is reported as repaired and a copy of it is kept.
const TASK_LIMITS = { id: 100, title: 120, description: 2000, label: 30, labels: 10 };

// Fields written by this version. Anything else is reported as a repair (with a copy of the
// original file) rather than dropped silently on the next save.
const DOC_KEYS = ['schemaVersion', 'savedAt', 'settings', 'categories', 'tasks'];
const SETTINGS_KEYS = ['language', 'lastView', 'reminders', 'availability'];
const REMINDER_SETTINGS_KEYS = ['enabled', 'allDayTime'];
const AVAILABILITY_KEYS = ['start', 'end'];
const DEFAULT_REMINDER_SETTINGS = Object.freeze({ enabled: true, allDayTime: DEFAULT_ALL_DAY_REMINDER_TIME });
const LAST_VIEW_KEYS = ['destination', 'layout'];
const TASK_KEYS = [
  'id', 'title', 'description', 'priority', 'dueDate', 'dueTime', 'reminders', 'recurrence', 'estimateMinutes', 'planned',
  'labels', 'status', 'order', 'categoryId', 'subtasks', 'completedAt', 'createdAt', 'updatedAt',
];
const CATEGORY_KEYS = ['id', 'name', 'order', 'createdAt'];

// Upgrades from older document versions. Each entry converts version N to N + 1.
const MIGRATIONS = {
  // v0: unversioned data — either a bare task array or an object without schemaVersion.
  0: (raw) => ({
    tasks: Array.isArray(raw) ? raw : raw?.tasks,
    settings: (!Array.isArray(raw) && raw?.settings) || { language: DEFAULT_LANGUAGE },
  }),
  // v1 -> v2: categories were introduced. Existing tasks become uncategorized (categoryId null).
  1: (doc) => ({
    ...doc,
    categories: [],
    tasks: Array.isArray(doc?.tasks)
      ? doc.tasks.map((task) => (isPlainObject(task) ? { ...task, categoryId: null } : task))
      : doc?.tasks,
  }),
  // v2 -> v3: optional subtasks were introduced. Existing tasks get an empty list.
  // Safe to repeat: a task that already has a subtask array keeps it.
  2: (doc) => ({
    ...doc,
    tasks: Array.isArray(doc?.tasks)
      ? doc.tasks.map((task) => (isPlainObject(task) ? { ...task, subtasks: Array.isArray(task.subtasks) ? task.subtasks : [] } : task))
      : doc?.tasks,
  }),
  // v3 -> v4: optional due times, reminders, recurrence, estimates, day-plan slots and the
  // completion time. Existing tasks get none of them; completed tasks take their last update as
  // the best known completion time. Safe to repeat: present values are kept.
  3: (doc) => ({
    ...doc,
    tasks: Array.isArray(doc?.tasks)
      ? doc.tasks.map((task) =>
          isPlainObject(task)
            ? {
                ...task,
                dueTime: task.dueTime ?? null,
                reminders: Array.isArray(task.reminders) ? task.reminders : [],
                recurrence: task.recurrence ?? null,
                estimateMinutes: task.estimateMinutes ?? null,
                planned: task.planned ?? null,
                completedAt: task.completedAt !== undefined ? task.completedAt : task.status === 'done' && typeof task.updatedAt === 'string' ? task.updatedAt : null,
              }
            : task,
        )
      : doc?.tasks,
  }),
};

class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const limitedString = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
const hasUnknownKeys = (value, known) => isPlainObject(value) && Object.keys(value).some((key) => !known.includes(key));

/** A real calendar date in "YYYY-MM-DD" form (2026-02-30 is rejected, as in the renderer). */
function isCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Same rules as normalizeLabels in the renderer: collapsed whitespace, no empty or duplicate labels. */
function sanitizeLabels(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const labels = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const label = item.replace(/\s+/g, ' ').trim().slice(0, TASK_LIMITS.label).trimEnd();
    const key = label.toLocaleLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
    if (labels.length === TASK_LIMITS.labels) break;
  }
  return labels;
}

/** One-level subtasks: { id, title, done } only; invalid entries and duplicate ids are dropped. */
function sanitizeSubtasks(raw) {
  if (raw === undefined) return { subtasks: [], changed: false };
  if (!Array.isArray(raw)) return { subtasks: [], changed: true };
  const seen = new Set();
  const subtasks = [];
  for (const item of raw.slice(0, MAX_SUBTASKS)) {
    const id = isPlainObject(item) ? limitedString(item.id, 100) : null;
    const title = isPlainObject(item) && typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim().slice(0, MAX_SUBTASK_TITLE).trimEnd() : '';
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    subtasks.push({ id, title, done: item.done === true });
  }
  const changed =
    subtasks.length !== raw.length ||
    subtasks.some((subtask, index) => subtask.id !== raw[index].id || subtask.title !== raw[index].title || subtask.done !== raw[index].done || Object.keys(raw[index]).length !== 3);
  return { subtasks, changed };
}

/**
 * Returns a clean task containing only known fields, or null when the record cannot be
 * used at all (no id or no title). `changed` reports whether any field had to be fixed.
 */
function sanitizeTask(raw) {
  if (!isPlainObject(raw)) return { task: null, changed: true };
  const id = limitedString(raw.id, TASK_LIMITS.id);
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, TASK_LIMITS.title).trimEnd() : '';
  if (!id || !title) return { task: null, changed: true };

  const subtaskResult = sanitizeSubtasks(raw.subtasks);
  const labels = sanitizeLabels(raw.labels);
  const dueDate = isCalendarDate(raw.dueDate) ? raw.dueDate : null;
  const dueTime = normalizeDueTime(raw.dueTime, dueDate);
  const reminders = normalizeReminders(raw.reminders, dueDate, dueTime);
  const recurrence = normalizeRecurrence(raw.recurrence, dueDate);
  const planned = isPlainObject(raw.planned) && isCalendarDate(raw.planned.date) && isTimeKey(raw.planned.time) ? { date: raw.planned.date, time: raw.planned.time } : null;
  const task = {
    id,
    title,
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, TASK_LIMITS.description).trimEnd() : '',
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'medium',
    dueDate,
    dueTime,
    reminders,
    recurrence,
    estimateMinutes: normalizeEstimate(raw.estimateMinutes),
    planned,
    labels,
    status: STATUSES.includes(raw.status) ? raw.status : 'todo',
    order: Number.isFinite(raw.order) ? raw.order : 0,
    categoryId: typeof raw.categoryId === 'string' && raw.categoryId ? raw.categoryId.slice(0, 100) : null,
    subtasks: subtaskResult.subtasks,
    completedAt: limitedString(raw.completedAt, 40),
    createdAt: limitedString(raw.createdAt, 40) ?? new Date(0).toISOString(),
    updatedAt: limitedString(raw.updatedAt, 40) ?? new Date(0).toISOString(),
  };

  const changed =
    hasUnknownKeys(raw, TASK_KEYS) ||
    task.id !== raw.id ||
    task.description !== (raw.description ?? '') ||
    task.priority !== raw.priority ||
    task.dueDate !== (raw.dueDate ?? null) ||
    task.dueTime !== (raw.dueTime ?? null) ||
    JSON.stringify(task.reminders) !== JSON.stringify(raw.reminders ?? []) ||
    JSON.stringify(task.recurrence) !== JSON.stringify(raw.recurrence ?? null) ||
    task.estimateMinutes !== (raw.estimateMinutes ?? null) ||
    JSON.stringify(task.planned) !== JSON.stringify(raw.planned ?? null) ||
    task.completedAt !== (raw.completedAt ?? null) ||
    task.status !== raw.status ||
    task.order !== raw.order ||
    task.categoryId !== (raw.categoryId ?? null) ||
    subtaskResult.changed ||
    labels.length !== (Array.isArray(raw.labels) ? raw.labels.length : 0) ||
    labels.some((label, index) => label !== raw.labels[index]) ||
    task.createdAt !== raw.createdAt ||
    task.updatedAt !== raw.updatedAt ||
    task.title !== raw.title;
  return { task, changed };
}

/** Validates/normalizes a task array. Duplicate ids keep the first occurrence. */
function sanitizeTasks(rawTasks) {
  const seen = new Set();
  const tasks = [];
  let dropped = 0;
  let changed = false;
  for (const raw of rawTasks.slice(0, MAX_TASKS)) {
    const result = sanitizeTask(raw);
    if (!result.task || seen.has(result.task.id)) {
      dropped += 1;
      continue;
    }
    seen.add(result.task.id);
    if (result.changed) changed = true;
    tasks.push(result.task);
  }
  dropped += Math.max(0, rawTasks.length - MAX_TASKS);
  return { tasks, dropped, changed: changed || dropped > 0 };
}

/** Validates categories: unique ids, non-empty names (case-insensitive unique). */
function sanitizeCategories(rawCategories) {
  if (!Array.isArray(rawCategories)) return { categories: [], dropped: 0, changed: rawCategories !== undefined };
  const ids = new Set();
  const names = new Set();
  const categories = [];
  let dropped = 0;
  let changed = false;
  for (const raw of rawCategories.slice(0, MAX_CATEGORIES)) {
    const id = isPlainObject(raw) ? limitedString(raw.id, 100) : null;
    const name = isPlainObject(raw) && typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim().slice(0, MAX_CATEGORY_NAME).trimEnd() : '';
    if (!id || !name || ids.has(id) || names.has(name.toLocaleLowerCase())) {
      dropped += 1;
      continue;
    }
    ids.add(id);
    names.add(name.toLocaleLowerCase());
    const category = {
      id,
      name,
      order: Number.isFinite(raw.order) ? raw.order : categories.length,
      createdAt: limitedString(raw.createdAt, 40) ?? new Date(0).toISOString(),
    };
    if (
      hasUnknownKeys(raw, CATEGORY_KEYS) ||
      category.id !== raw.id ||
      category.name !== raw.name ||
      category.order !== raw.order ||
      category.createdAt !== raw.createdAt
    ) {
      changed = true;
    }
    categories.push(category);
  }
  dropped += Math.max(0, rawCategories.length - MAX_CATEGORIES);
  return { categories, dropped, changed: changed || dropped > 0 };
}

/** Tasks pointing at a category that does not exist become uncategorized. */
function detachUnknownCategories(tasks, categories) {
  const known = new Set(categories.map((category) => category.id));
  let changed = false;
  const result = tasks.map((task) => {
    if (task.categoryId === null || known.has(task.categoryId)) return task;
    changed = true;
    return { ...task, categoryId: null };
  });
  return { tasks: result, changed };
}

/** Validates the remembered view; an unknown category falls back to All tasks. */
function sanitizeLastView(raw, categories) {
  if (!isPlainObject(raw)) return { ...DEFAULT_LAST_VIEW };
  const layout = LAYOUTS.includes(raw.layout) ? raw.layout : DEFAULT_LAST_VIEW.layout;
  const known =
    typeof raw.destination === 'string' &&
    (raw.destination === ALL_TASKS ||
      raw.destination === UNCATEGORIZED ||
      categories.some((category) => category.id === raw.destination));
  return { destination: known ? raw.destination : ALL_TASKS, layout };
}

/**
 * `changed` reports an invalid language or unknown setting fields; an invalid lastView value
 * silently falls back (it is optional).
 */
/** Reminder settings: { enabled, allDayTime } (the time reminders of tasks without a due time fire). */
function sanitizeReminderSettings(raw) {
  if (!isPlainObject(raw)) return { ...DEFAULT_REMINDER_SETTINGS };
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_REMINDER_SETTINGS.enabled,
    allDayTime: isTimeKey(raw.allDayTime) ? raw.allDayTime : DEFAULT_REMINDER_SETTINGS.allDayTime,
  };
}

/** Planning availability { start, end } ("HH:MM", start before end) or null (not set). */
function sanitizeAvailability(raw) {
  return isPlainObject(raw) && isTimeKey(raw.start) && isTimeKey(raw.end) && raw.start < raw.end ? { start: raw.start, end: raw.end } : null;
}

function sanitizeSettings(raw, categories = []) {
  const language = isPlainObject(raw) && LANGUAGES.includes(raw.language) ? raw.language : DEFAULT_LANGUAGE;
  const reminders = sanitizeReminderSettings(isPlainObject(raw) ? raw.reminders : null);
  const availability = sanitizeAvailability(isPlainObject(raw) ? raw.availability : null);
  return {
    settings: { language, lastView: sanitizeLastView(isPlainObject(raw) ? raw.lastView : null, categories), reminders, availability },
    changed:
      !isPlainObject(raw) ||
      raw.language !== language ||
      hasUnknownKeys(raw, SETTINGS_KEYS) ||
      hasUnknownKeys(raw.lastView, LAST_VIEW_KEYS) ||
      hasUnknownKeys(raw.reminders, REMINDER_SETTINGS_KEYS) ||
      hasUnknownKeys(raw.availability, AVAILABILITY_KEYS) ||
      (raw.reminders !== undefined && JSON.stringify(raw.reminders) !== JSON.stringify(reminders)) ||
      (raw.availability !== undefined && raw.availability !== null && JSON.stringify(raw.availability) !== JSON.stringify(availability)),
  };
}

/** Parses and upgrades raw JSON into a current-version document. */
function toCurrentDocument(raw) {
  let doc = raw;
  let version = isPlainObject(raw) && Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 0;
  if (version > SCHEMA_VERSION) throw new StorageError('NEWER_VERSION', `Schema ${version} is newer than ${SCHEMA_VERSION}`);
  const migrated = version < SCHEMA_VERSION;
  while (version < SCHEMA_VERSION) {
    doc = MIGRATIONS[version](doc);
    version += 1;
  }
  if (!isPlainObject(doc) || !Array.isArray(doc.tasks)) throw new StorageError('INVALID', 'Missing task list');

  const tasks = sanitizeTasks(doc.tasks);
  const categories = sanitizeCategories(doc.categories);
  const linked = detachUnknownCategories(tasks.tasks, categories.categories);
  const settings = sanitizeSettings(doc.settings, categories.categories);
  return {
    doc: { schemaVersion: SCHEMA_VERSION, settings: settings.settings, categories: categories.categories, tasks: linked.tasks },
    dropped: tasks.dropped + categories.dropped,
    repaired: tasks.changed || categories.changed || linked.changed || settings.changed || hasUnknownKeys(doc, DOC_KEYS),
    migrated,
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** fs.renameSync with retries: on Windows, antivirus or indexers can briefly lock files. */
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      sleepSync(30 * (attempt + 1));
    }
  }
}

function createStorage(dir) {
  const file = path.join(dir, FILE_NAME);
  const backupFile = `${file}.bak`;
  const tempFile = `${file}.tmp`;

  let doc = null;
  let writable = false;
  let loadResult = null;
  // False while the current file is known to be unreadable: it must not become the backup.
  let currentFileTrusted = true;

  function readDocument(target) {
    const { size } = fs.statSync(target);
    if (size > MAX_FILE_BYTES) throw new StorageError('INVALID', 'File too large');
    const text = fs.readFileSync(target, 'utf8').replace(/^﻿/, '');
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new StorageError('INVALID', error.message);
    }
    return toCurrentDocument(raw);
  }

  /** Keeps a copy of a problematic file next to the data; never deletes the original. */
  function preserveCopy(source, reason) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `taskflow-data.${reason}-${stamp}.json`);
    fs.copyFileSync(source, target);
    return target;
  }

  function writeDocument() {
    const json = JSON.stringify({ ...doc, schemaVersion: SCHEMA_VERSION, savedAt: new Date().toISOString() }, null, 2);
    const fd = fs.openSync(tempFile, 'w');
    try {
      fs.writeSync(fd, json, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (currentFileTrusted && fs.existsSync(file)) {
      // copyFile also copies a read-only attribute, which would block later backups.
      fs.rmSync(backupFile, { force: true });
      fs.copyFileSync(file, backupFile);
      fs.chmodSync(backupFile, 0o666);
    }
    renameWithRetry(tempFile, file);
    currentFileTrusted = true;
  }

  function emptyDocument(language = DEFAULT_LANGUAGE) {
    return { schemaVersion: SCHEMA_VERSION, settings: { language, lastView: { ...DEFAULT_LAST_VIEW }, reminders: { ...DEFAULT_REMINDER_SETTINGS }, availability: null }, categories: [], tasks: [] };
  }

  function finish(status, extra = {}) {
    loadResult = {
      status,
      writable,
      settings: { ...doc.settings },
      categories: status === 'new' ? null : doc.categories,
      // null tells the renderer this is a first launch (seed sample tasks).
      tasks: status === 'new' ? null : doc.tasks,
      dataFile: file,
      ...extra,
    };
    return loadResult;
  }

  /**
   * { parsed } for a usable backup; { preservedBackup } when a backup exists but cannot be used
   * (damaged, or from a newer version). It is copied first, because the next saves rotate the
   * backup and would otherwise overwrite what may be the only remaining copy of the data.
   */
  function tryBackup() {
    if (!fs.existsSync(backupFile)) return {};
    try {
      return { parsed: readDocument(backupFile) };
    } catch {
      try {
        return { preservedBackup: preserveCopy(backupFile, 'unusable-backup') };
      } catch {
        return {};
      }
    }
  }

  function load() {
    if (loadResult) {
      // A renderer reload must receive the current data, not the startup snapshot,
      // otherwise it could save stale data over newer changes.
      return {
        ...loadResult,
        status: writable ? 'loaded' : loadResult.status,
        settings: { ...doc.settings },
        categories: doc.categories,
        tasks: doc.tasks,
      };
    }
    fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(file)) {
      const backup = tryBackup();
      writable = true;
      if (backup.parsed) {
        doc = backup.parsed.doc;
        return finish('recovered', { preservedCopy: null });
      }
      doc = emptyDocument();
      // A backup without a data file is not a first launch: report it instead of seeding samples.
      if (backup.preservedBackup) return finish('unreadable', { preservedCopy: backup.preservedBackup });
      return finish('new');
    }

    let parsed;
    try {
      parsed = readDocument(file);
    } catch (error) {
      if (error.code === 'NEWER_VERSION') {
        // Written by a newer Taskflow: never overwrite it.
        doc = emptyDocument();
        writable = false;
        return finish('newer-version');
      }
      if (error.code !== 'INVALID') {
        // I/O failure (locked, permissions): the data may be fine, so do not write.
        doc = emptyDocument();
        writable = false;
        return finish('read-error', { errorCode: error.code ?? 'UNKNOWN' });
      }
      const preservedCopy = preserveCopy(file, 'unreadable');
      const backup = tryBackup();
      writable = true;
      currentFileTrusted = false;
      if (backup.parsed) {
        doc = backup.parsed.doc;
        return finish('recovered', { preservedCopy });
      }
      doc = emptyDocument();
      return finish('unreadable', { preservedCopy, preservedBackup: backup.preservedBackup ?? null });
    }

    doc = parsed.doc;
    writable = true;
    if (parsed.repaired) {
      const preservedCopy = preserveCopy(file, 'before-repair');
      return finish('repaired', { preservedCopy, dropped: parsed.dropped });
    }
    if (parsed.migrated) {
      return finish('migrated', { preservedCopy: preserveCopy(file, 'before-migration') });
    }
    return finish('loaded');
  }

  function save(mutate) {
    if (!doc) return { ok: false, code: 'NOT_LOADED' };
    if (!writable) return { ok: false, code: 'READ_ONLY' };
    const previous = doc;
    try {
      doc = mutate(doc);
      writeDocument();
      return { ok: true };
    } catch (error) {
      doc = previous;
      try {
        fs.rmSync(tempFile, { force: true });
      } catch {
        // ignore cleanup failure
      }
      return { ok: false, code: error.code ?? 'WRITE_FAILED' };
    }
  }

  function saveTasks(rawTasks) {
    if (!Array.isArray(rawTasks) || rawTasks.length > MAX_TASKS) return { ok: false, code: 'INVALID_INPUT' };
    const { tasks } = detachUnknownCategories(sanitizeTasks(rawTasks).tasks, doc.categories ?? []);
    return save((current) => ({ ...current, tasks }));
  }

  /** Saves tasks and categories together so assignments always stay consistent. */
  function saveBoard(board) {
    if (!isPlainObject(board) || !Array.isArray(board.tasks) || !Array.isArray(board.categories)) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    if (board.tasks.length > MAX_TASKS || board.categories.length > MAX_CATEGORIES) return { ok: false, code: 'INVALID_INPUT' };
    const { categories } = sanitizeCategories(board.categories);
    const { tasks } = detachUnknownCategories(sanitizeTasks(board.tasks).tasks, categories);
    return save((current) => ({
      ...current,
      categories,
      tasks,
      // Deleting the remembered category must not leave a dangling reference.
      settings: { ...current.settings, lastView: sanitizeLastView(current.settings.lastView, categories) },
    }));
  }

  /** Accepts { language?, lastView?, reminders?, availability? }; each provided value is validated. */
  function saveSettings(rawSettings) {
    if (!isPlainObject(rawSettings)) return { ok: false, code: 'INVALID_INPUT' };
    if ('language' in rawSettings && !LANGUAGES.includes(rawSettings.language)) return { ok: false, code: 'INVALID_INPUT' };
    if ('reminders' in rawSettings && (!isPlainObject(rawSettings.reminders) || hasUnknownKeys(rawSettings.reminders, REMINDER_SETTINGS_KEYS))) return { ok: false, code: 'INVALID_INPUT' };
    if ('availability' in rawSettings && rawSettings.availability !== null && !sanitizeAvailability(rawSettings.availability)) return { ok: false, code: 'INVALID_INPUT' };
    return save((current) => {
      const next = { ...current.settings };
      if ('language' in rawSettings) next.language = rawSettings.language;
      if ('lastView' in rawSettings) next.lastView = sanitizeLastView(rawSettings.lastView, current.categories ?? []);
      if ('reminders' in rawSettings) next.reminders = sanitizeReminderSettings(rawSettings.reminders);
      if ('availability' in rawSettings) next.availability = sanitizeAvailability(rawSettings.availability);
      return { ...current, settings: next };
    });
  }

  /**
   * The current data without loading it: null until the app has loaded it once (so a background
   * reader never triggers the first load, its migration or repair, or changes what the window
   * is told about it).
   */
  function peek() {
    return doc ? { tasks: doc.tasks, settings: doc.settings, categories: doc.categories } : null;
  }

  return { load, peek, saveTasks, saveBoard, saveSettings, file };
}

module.exports = { createStorage, SCHEMA_VERSION, FILE_NAME };
