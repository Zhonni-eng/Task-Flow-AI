// Shared pieces of the provider adapters (main process only): the structured answer every
// provider is asked for, its conversion into the app's action-plan format, and a small JSON-over-
// HTTP helper for providers called without an SDK.
//
// Errors are mapped to app codes by HTTP status / failure kind only - never by (or with) response
// text, which could echo the key or other data.

const MAX_RESPONSE_CHARS = 64 * 1024; // the model's JSON answer
const MAX_BODY_CHARS = 2 * 1024 * 1024; // a whole HTTP response body

// Structured-output schema (JSON Schema, strict-mode compatible: every field required, no extra
// fields). The model answers with a list of actions; every action object has every field, and
// fields that do not apply are "" / [] / 0 / "unset". The app validates every value again.
//
// Action types:
// A rename is always an explicit `newTitle`. `title` only names a NEW task or subtask: strict output
// makes every action carry every field, and models fill `title` of other actions with the existing
// task's title - which must never turn "mark it done" into a rename.
//
//   create         a new task (title, description, dueDate, dueTime, priority, status, categoryId
//                  or newCategory, subtasks, labels, reminders, recurrence, estimateMinutes)
//   update         taskId + the fields to change (newTitle to rename); "clear" lists fields to remove;
//                  labels here (and in bulk) are tags to ADD - the task's existing tags are kept;
//                  removeLabels (here and in bulk) takes tags off these tasks only
//   renameLabel    label -> newLabel on every task that has it
//   deleteLabel    label taken off every task (the tasks stay)
//   delete         taskId
//   addSubtask     taskId + title; updateSubtask taskId + subtaskId + newTitle and/or done;
//   deleteSubtask  taskId + subtaskId; moveSubtask taskId + subtaskId + toTaskId
//   bulk           filter (status, categoryId, priority, due, completedOlderThanDays, titleContains,
//                  or scope "all" for every task, completed ones included) + operation "update" (with the fields to change) or "delete"; the APP finds the
//                  matching tasks and shows them before anything changes
//   schedule       a proposed day plan: date + items [{ taskId, start }]
const ACTION_TYPES = ['create', 'update', 'delete', 'addSubtask', 'updateSubtask', 'deleteSubtask', 'moveSubtask', 'bulk', 'schedule', 'renameLabel', 'deleteLabel'];
const CLEARABLE = ['dueDate', 'dueTime', 'description', 'categoryId', 'reminders', 'recurrence', 'estimateMinutes', 'planned'];
const str = { type: 'string' };
const int = { type: 'integer' };
const choice = (values) => ({ type: 'string', enum: ['unset', ...values] });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const RESPONSE_SCHEMA = object({
  reply: str,
  question: str,
  actions: {
    type: 'array',
    items: object({
      type: { type: 'string', enum: ACTION_TYPES },
      taskId: str,
      subtaskId: str,
      toTaskId: str,
      title: str,
      newTitle: str,
      description: str,
      status: choice(['todo', 'inProgress', 'done']),
      priority: choice(['low', 'medium', 'high']),
      dueDate: str,
      dueTime: str,
      categoryId: str,
      newCategory: str,
      subtasks: { type: 'array', items: str },
      labels: { type: 'array', items: str },
      removeLabels: { type: 'array', items: str },
      label: str,
      newLabel: str,
      reminders: { type: 'array', items: int },
      recurrence: object({ freq: choice(['daily', 'weekly', 'monthly']), interval: int, weekdays: { type: 'array', items: int }, monthDay: int }),
      estimateMinutes: int,
      done: choice(['true', 'false']),
      clear: { type: 'array', items: { type: 'string', enum: CLEARABLE } },
      filter: object({
        status: choice(['todo', 'inProgress', 'done']),
        categoryId: str,
        priority: choice(['low', 'medium', 'high']),
        due: choice(['overdue', 'today', 'upcoming', 'noDate']),
        completedOlderThanDays: int,
        titleContains: str,
        scope: choice(['all']),
      }),
      operation: choice(['update', 'delete']),
      date: str,
      items: { type: 'array', items: object({ taskId: str, start: str }) },
    }),
  },
});

const MAX_ACTIONS = 50;
const isSet = (value) => typeof value === 'string' && value !== '' && value !== 'unset';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasLabels = (raw, key = 'labels') => Array.isArray(raw[key]) && raw[key].length > 0;

/**
 * Task fields given in a wire action, plus cleared ones as null/[]. `titleFrom`: which wire field
 * sets the task's title - 'title' for create, 'newTitle' for update, null for bulk (never renamed).
 */
function fieldsOf(raw, titleFrom) {
  const fields = {};
  if (titleFrom && isSet(raw[titleFrom])) fields.title = raw[titleFrom];
  for (const key of ['description', 'dueDate', 'dueTime', 'categoryId', 'newCategory']) if (isSet(raw[key])) fields[key] = raw[key];
  for (const key of ['status', 'priority']) if (isSet(raw[key])) fields[key] = raw[key];
  if (Array.isArray(raw.subtasks) && raw.subtasks.length > 0) fields.subtasks = raw.subtasks;
  if (Array.isArray(raw.reminders) && raw.reminders.length > 0) fields.reminders = raw.reminders;
  if (isObject(raw.recurrence) && isSet(raw.recurrence.freq)) {
    const rule = { freq: raw.recurrence.freq, interval: raw.recurrence.interval || 1 };
    if (Array.isArray(raw.recurrence.weekdays) && raw.recurrence.weekdays.length > 0) rule.weekdays = raw.recurrence.weekdays;
    if (Number.isInteger(raw.recurrence.monthDay) && raw.recurrence.monthDay > 0) rule.monthDay = raw.recurrence.monthDay;
    fields.recurrence = rule;
  }
  if (Number.isInteger(raw.estimateMinutes) && raw.estimateMinutes > 0) fields.estimateMinutes = raw.estimateMinutes;
  if (Array.isArray(raw.clear)) {
    for (const key of raw.clear) {
      if (!CLEARABLE.includes(key)) return null;
      fields[key] = key === 'reminders' ? [] : key === 'description' ? '' : null;
    }
  }
  return fields;
}

/** One wire action -> an action of the app's plan format (validated later), or null. */
function toAction(raw) {
  if (!isObject(raw) || !ACTION_TYPES.includes(raw.type)) return null;
  switch (raw.type) {
    case 'create': {
      const fields = fieldsOf(raw, 'title');
      if (!fields) return null;
      if (hasLabels(raw)) fields.labels = raw.labels;
      return { type: 'create', title: raw.title, ...fields };
    }
    case 'update': {
      const changes = fieldsOf(raw, 'newTitle');
      if (changes && hasLabels(raw)) changes.addLabels = raw.labels;
      if (changes && hasLabels(raw, 'removeLabels')) changes.removeLabels = raw.removeLabels;
      return changes ? { type: 'update', taskId: raw.taskId, changes } : null;
    }
    case 'delete':
      return { type: 'delete', taskId: raw.taskId };
    case 'addSubtask':
      return { type: 'addSubtask', taskId: raw.taskId, title: raw.title };
    case 'updateSubtask': {
      const action = { type: 'updateSubtask', taskId: raw.taskId, subtaskId: raw.subtaskId };
      if (isSet(raw.newTitle)) action.title = raw.newTitle;
      if (raw.done === 'true' || raw.done === 'false') action.done = raw.done === 'true';
      return action;
    }
    case 'deleteSubtask':
      return { type: 'deleteSubtask', taskId: raw.taskId, subtaskId: raw.subtaskId };
    case 'moveSubtask':
      return { type: 'moveSubtask', taskId: raw.taskId, subtaskId: raw.subtaskId, toTaskId: raw.toTaskId };
    case 'bulk': {
      const changes = fieldsOf(raw, null);
      if (!changes || !isObject(raw.filter)) return null;
      if (hasLabels(raw)) changes.addLabels = raw.labels;
      if (hasLabels(raw, 'removeLabels')) changes.removeLabels = raw.removeLabels;
      const filter = {};
      for (const key of ['status', 'priority', 'due', 'categoryId', 'titleContains']) if (isSet(raw.filter[key])) filter[key] = raw.filter[key];
      if (Number.isInteger(raw.filter.completedOlderThanDays) && raw.filter.completedOlderThanDays > 0) filter.completedOlderThanDays = raw.filter.completedOlderThanDays;
      if (raw.filter.scope === 'all') filter.scope = 'all';
      return { type: 'bulk', operation: raw.operation, filter, changes };
    }
    case 'renameLabel':
      return { type: 'renameLabel', label: raw.label, newLabel: raw.newLabel };
    case 'deleteLabel':
      return { type: 'deleteLabel', label: raw.label };
    case 'schedule':
      return { type: 'schedule', date: raw.date, items: Array.isArray(raw.items) ? raw.items.filter(isObject).map((item) => ({ taskId: item.taskId, start: item.start })) : raw.items };
    default:
      return null;
  }
}

/** Answers in the format of earlier versions ({ tasks, statusChanges, dueDateChanges }). */
function legacyActions(parsed) {
  const actions = [];
  for (const task of parsed.tasks ?? []) {
    if (!isObject(task)) return null;
    const action = { type: 'create', title: task.title };
    if (task.dueDate !== '' && task.dueDate !== undefined) action.dueDate = task.dueDate;
    if (task.priority !== undefined) action.priority = task.priority;
    if (task.categoryId !== '' && task.categoryId !== undefined) action.categoryId = task.categoryId;
    if (Array.isArray(task.subtasks) && task.subtasks.length > 0) action.subtasks = task.subtasks;
    actions.push(action);
  }
  for (const change of parsed.statusChanges ?? []) {
    if (!isObject(change)) return null;
    actions.push({ type: 'update', taskId: change.taskId, changes: { status: change.status } });
  }
  for (const change of parsed.dueDateChanges ?? []) {
    if (!isObject(change)) return null;
    actions.push({ type: 'update', taskId: change.taskId, changes: { dueDate: change.dueDate === '' ? null : change.dueDate } });
  }
  return actions;
}

/** Turns the model's JSON into the app's action-plan format, or null when it is not usable. */
function toPlan(parsed) {
  if (!isObject(parsed)) return null;
  const { reply, question } = parsed;
  if (typeof reply !== 'string' || typeof question !== 'string') return null;
  let actions;
  if (Array.isArray(parsed.actions)) {
    if (parsed.actions.length > MAX_ACTIONS) return null;
    actions = parsed.actions.map(toAction);
    if (actions.some((action) => action === null)) return null;
  } else {
    if (!Array.isArray(parsed.tasks ?? []) || !Array.isArray(parsed.statusChanges ?? []) || !Array.isArray(parsed.dueDateChanges ?? [])) return null;
    actions = legacyActions(parsed);
    if (!actions || actions.length > MAX_ACTIONS) return null;
  }
  return { reply, question, actions: actions.length > 0 ? actions : [{ type: 'none' }] };
}

/** The model's answer text -> { plan } or { code: 'MALFORMED' }. */
function planFromText(text) {
  if (typeof text !== 'string' || !text || text.length > MAX_RESPONSE_CHARS) return { code: 'MALFORMED' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { code: 'MALFORMED' };
  }
  const plan = toPlan(parsed);
  return plan ? { plan } : { code: 'MALFORMED' };
}

/** App code for an HTTP error status (the same mapping for every provider). */
function codeForStatus(status) {
  if (status === 401) return 'AUTH';
  if (status === 403) return 'PERMISSION';
  if (status === 404) return 'MODEL_UNAVAILABLE';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 529 || status === 503) return 'OVERLOADED';
  if (status >= 500) return 'PROVIDER_ERROR';
  if (status === 400 || status === 413 || status === 422) return 'BAD_REQUEST';
  return 'PROVIDER_ERROR';
}

/**
 * One request with a JSON answer (JSON or multipart `form` body). Never follows redirects (the key must not be forwarded to another address),
 * aborts after `timeoutMs`, and limits the body size. Returns { ok: true, json } for 2xx JSON,
 * otherwise { ok: false, code } - TIMEOUT, NETWORK, an HTTP-status code, or MALFORMED.
 */
async function requestJson({ fetch, url, method = 'GET', headers = {}, body, form, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      // `form` (FormData) is sent as multipart; fetch sets its content type with the boundary.
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return { ok: false, code: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK' };
  }
  let text;
  try {
    text = await response.text();
  } catch {
    clearTimeout(timer);
    return { ok: false, code: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK' };
  }
  clearTimeout(timer);
  if (response.status >= 300 && response.status < 400) return { ok: false, code: 'PROVIDER_ERROR' };
  if (!response.ok) return { ok: false, code: codeForStatus(response.status) };
  if (typeof text !== 'string' || text.length > MAX_BODY_CHARS) return { ok: false, code: 'MALFORMED' };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, code: 'MALFORMED' };
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

module.exports = { RESPONSE_SCHEMA, ACTION_TYPES, CLEARABLE, MAX_ACTIONS, MAX_RESPONSE_CHARS, toPlan, planFromText, codeForStatus, requestJson, isPlainObject };
