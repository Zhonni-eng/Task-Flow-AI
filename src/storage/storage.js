// Renderer-side persistence: talks to the restricted preload API (window.taskflow.storage)
// and keeps IPC details out of React components.
import { DEFAULT_LANGUAGE, LANGUAGES } from '../i18n/translations.js';
import { createSaveQueue } from './saveQueue.js';

const bridge = typeof window !== 'undefined' ? window.taskflow?.storage : undefined;
const LEGACY_LANGUAGE_KEY = 'taskflow.language';

const isLanguage = (code) => LANGUAGES.some((lang) => lang.code === code);

// ---------- Save status (for the notice banner) ----------
// Tracked per queue: a successful board save must not hide a failed settings save (and the
// other way round). The banner shows the first failure; it clears once both queues succeed.
let saveStatus = { ok: true };
const queueStatus = { board: { ok: true }, settings: { ok: true } };
const listeners = new Set();

function setQueueStatus(queue, result) {
  queueStatus[queue] = result.ok ? { ok: true } : { ok: false, code: result.code };
  const failed = [queueStatus.board, queueStatus.settings].find((status) => !status.ok);
  const next = failed ?? { ok: true };
  if (next.ok === saveStatus.ok && next.code === saveStatus.code) return;
  saveStatus = next;
  listeners.forEach((listener) => listener(saveStatus));
}

export function getSaveStatus() {
  return saveStatus;
}

export function subscribeSaveStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------- Queues ----------
let writable = false;

// Waiters for "the next board save": armed when a board snapshot is queued after they registered,
// resolved with that write's real result (used to confirm AI-created tasks were actually saved).
let boardWaiters = [];
let armedWaiters = [];

const boardQueue = createSaveQueue(
  async (board) => {
    const waiting = armedWaiters;
    armedWaiters = [];
    let result;
    try {
      result = await bridge.saveBoard(board);
    } catch (error) {
      waiting.forEach((resolve) => resolve({ ok: false, code: 'IPC_FAILED' }));
      throw error;
    }
    waiting.forEach((resolve) => resolve(result?.ok ? { ok: true } : { ok: false, code: result?.code ?? 'NO_RESULT' }));
    return result;
  },
  (result) => setQueueStatus('board', result),
);

/**
 * Resolves with { ok, code? } of the first board save queued after this call (or after
 * `timeoutMs` with { ok: false, code: 'NO_SAVE' }). Read-only data resolves as not saved.
 */
export function waitForNextBoardSave(timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      boardWaiters = boardWaiters.filter((item) => item !== finish);
      armedWaiters = armedWaiters.filter((item) => item !== finish);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'NO_SAVE' }), timeoutMs);
    boardWaiters.push(finish);
  });
}
const settingsQueue = createSaveQueue((settings) => bridge.saveSettings(settings), (result) => setQueueStatus('settings', result));

/** Saves { tasks, categories } as one write. */
export function saveBoard(board) {
  if (!writable) {
    const waiting = boardWaiters;
    boardWaiters = [];
    waiting.forEach((resolve) => resolve({ ok: false, code: 'READ_ONLY' }));
    return;
  }
  armedWaiters = [...armedWaiters, ...boardWaiters];
  boardWaiters = [];
  boardQueue.save(board);
}

// Settings are always sent as one merged snapshot, so a language change and a view
// change saved in quick succession can never drop each other.
let settingsSnapshot = {};

function saveSettings(partial) {
  settingsSnapshot = { ...settingsSnapshot, ...partial };
  if (!writable) return;
  settingsQueue.save(settingsSnapshot);
}

export function saveLanguage(language) {
  saveSettings({ language });
}

/** Remembers the selected sidebar destination and Board/List layout. */
export function saveLastView(lastView) {
  saveSettings({ lastView });
}

/** Reminder settings: { enabled, allDayTime }. */
export function saveReminderSettings(reminders) {
  saveSettings({ reminders });
}

/** Planning availability { start, end } or null. */
export function saveAvailability(availability) {
  saveSettings({ availability });
}

export function retrySave() {
  return Promise.all([boardQueue.retry(), settingsQueue.retry()]);
}

export function flushSaves() {
  return Promise.all([boardQueue.flush(), settingsQueue.flush()]);
}

function readLegacyLanguage() {
  try {
    const stored = window.localStorage.getItem(LEGACY_LANGUAGE_KEY);
    return isLanguage(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Loads saved data before the UI renders. Never throws.
 * Result: { status, writable, language, tasks / categories (null = first launch), preservedCopy?, dataFile? }
 */
export async function loadAppData() {
  if (!bridge) {
    // Not running inside Taskflow's Electron shell (e.g. a plain browser preview).
    return { status: 'unavailable', writable: false, language: readLegacyLanguage() ?? DEFAULT_LANGUAGE, tasks: null, categories: null, lastView: null };
  }

  let result;
  try {
    result = await bridge.load();
  } catch {
    result = null;
  }
  if (!result || typeof result.status !== 'string') {
    return { status: 'read-error', writable: false, language: DEFAULT_LANGUAGE, tasks: [], categories: [], lastView: null };
  }

  writable = Boolean(result.writable);
  bridge.onBeforeClose(flushSaves);

  let language = isLanguage(result.settings?.language) ? result.settings.language : DEFAULT_LANGUAGE;
  const lastView = result.settings?.lastView ?? null;
  const reminders = result.settings?.reminders ?? { enabled: true, allDayTime: '09:00' };
  const availability = result.settings?.availability ?? null;
  settingsSnapshot = { language, ...(lastView ? { lastView } : {}), reminders, availability };
  // Earlier versions kept only the language, in localStorage: carry it over once.
  if (result.status === 'new') {
    const legacy = readLegacyLanguage();
    if (legacy && legacy !== language) {
      language = legacy;
      saveLanguage(language);
    }
  }

  return {
    status: result.status,
    writable,
    language,
    tasks: Array.isArray(result.tasks) ? result.tasks : null,
    categories: Array.isArray(result.categories) ? result.categories : null,
    lastView,
    reminders,
    availability,
    preservedCopy: result.preservedCopy ?? null,
    dataFile: result.dataFile ?? null,
  };
}
