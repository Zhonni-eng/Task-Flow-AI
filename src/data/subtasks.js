// Subtasks: an optional, single-level checklist stored on the parent task.
//
// Subtask = { id: string, title: string, done: boolean }
// task.subtasks is an ordered array (array position = display order). Subtasks have no
// status, category or subtasks of their own; they always belong to exactly one parent.

export const SUBTASK_TITLE_LIMIT = 200;
export const SUBTASK_LIMIT = 100;

function generateId() {
  if (globalThis.crypto?.randomUUID) return `sub-${globalThis.crypto.randomUUID()}`;
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeSubtaskTitle(title) {
  return String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, SUBTASK_TITLE_LIMIT).trimEnd();
}

/** Error code ('subtaskRequired') or null. */
export function validateSubtaskTitle(title) {
  return normalizeSubtaskTitle(title) ? null : 'subtaskRequired';
}

export function createSubtask(title) {
  return { id: generateId(), title: normalizeSubtaskTitle(title), done: false };
}

/**
 * Cleans a subtask list: keeps only { id, title, done }, drops entries without an id or a
 * title, removes duplicate ids and enforces the limit. Never nests.
 */
export function normalizeSubtasks(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' ? raw.id.slice(0, 100) : '';
    const title = normalizeSubtaskTitle(raw.title);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, title, done: raw.done === true });
    if (result.length === SUBTASK_LIMIT) break;
  }
  return result;
}

/** { done, total } for a task, or null when it has no subtasks. */
export function subtaskProgress(task) {
  const list = task?.subtasks ?? [];
  if (list.length === 0) return null;
  return { done: list.filter((subtask) => subtask.done).length, total: list.length };
}
