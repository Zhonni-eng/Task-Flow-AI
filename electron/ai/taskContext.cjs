// Chooses the existing tasks a message is about, so the assistant sees only what it needs (never
// the whole task list): tasks of this assistant session (follow-ups), tasks whose title shares
// words with the message, and - when the message asks about them - overdue / due soon tasks, tasks
// of a mentioned category, status or priority, or open tasks for a day plan.
// Passed on per task: id, title, status, priority, category id, deadline, reminders, repeat rule,
// estimate, planned slot, completion date, tags; subtasks (with ids) only for tasks the message names
// or the session worked with. Never descriptions. Tasks carrying a tag the message names are included.

const MAX_CONTEXT_TASKS = 40;
const MIN_TOKEN = 3;
const DETAIL_FIELDS = ['id', 'title', 'status', 'priority', 'categoryId', 'dueDate', 'dueTime', 'reminders', 'recurrence', 'estimateMinutes', 'planned', 'completedAt', 'labels'];
const MAX_TAGS = 50;

// Words that say what to do rather than which task (RU/EN). They must not pull in unrelated tasks.
const STOP_WORDS = new Set(
  [
    // English
    'the', 'and', 'for', 'with', 'task', 'tasks', 'todo', 'mark', 'set', 'make', 'move', 'change', 'done', 'finished', 'complete',
    'completed', 'progress', 'start', 'started', 'due', 'date', 'deadline', 'today', 'tomorrow', 'yesterday', 'week', 'next', 'this',
    'that', 'please', 'remove', 'clear', 'from', 'into', 'it', 'its', 'my', 'all', 'reopen', 'monday', 'tuesday', 'wednesday',
    'thursday', 'friday', 'saturday', 'sunday', 'create', 'add', 'new', 'delete', 'rename', 'time', 'remind', 'every',
    // Russian
    'задача', 'задачи', 'задачу', 'задаче', 'задач', 'отметь', 'отметить', 'сделай', 'сделать', 'перенеси', 'перенести', 'поставь',
    'поставить', 'измени', 'изменить', 'готово', 'готова', 'готов', 'выполнено', 'выполнена', 'выполни', 'работе', 'работу',
    'срок', 'сроком', 'дедлайн', 'сегодня', 'завтра', 'вчера', 'послезавтра', 'неделю', 'неделе', 'следующую', 'следующий',
    'эту', 'это', 'этот', 'эта', 'её', 'ее', 'его', 'мою', 'мой', 'все', 'всё', 'убери', 'убрать', 'сними', 'снять', 'пожалуйста',
    'понедельник', 'вторник', 'среду', 'среда', 'четверг', 'пятницу', 'пятница', 'субботу', 'суббота', 'воскресенье', 'создай',
    'создать', 'добавь', 'добавить', 'новую', 'начни', 'начать', 'верни', 'вернуть', 'как', 'для', 'что', 'про', 'удали', 'удалить',
    'переименуй', 'время', 'напомни', 'каждый', 'каждую', 'каждое',
  ].map((word) => word.replace(/ё/g, 'е')),
);

// Words that ask for a group of tasks rather than naming one (folded text).
const INTENTS = [
  ['overdue', /просроч|опозд|overdue|late|missed/],
  ['today', /сегодн|today|tonight/],
  ['soon', /завтра|tomorrow|недел|week|скоро|soon|ближайш|upcoming|дедлайн|deadline|срок/],
  ['plan', /план|расписан|schedule|plan|agenda|мой день|my day/],
  // Completed tasks as a group ("выполненные", "completed tasks") - not "X is done", which names one task.
  ['done', /выполненн|завершенн|сделанн|completed tasks|finished tasks|done tasks|what (have|did) i (do|done|finish|complete)/],
  ['inProgress', /в работе|in progress|начат/],
  ['high', /важн|срочн|приоритет|urgent|important|priority/],
];

const fold = (text) => String(text ?? '').toLocaleLowerCase('ru').replace(/ё/g, 'е');

function tokens(text) {
  return (fold(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= MIN_TOKEN && !STOP_WORDS.has(word));
}

/**
 * Same word or same stem: the shorter word without its ending starts the longer one. The ending is
 * one letter, or two for words of 6+ letters (Russian case endings: "лабораторная" / "лабораторной").
 */
function wordsMatch(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4) return false;
  const ending = short.length >= 6 ? 2 : 1;
  return long.startsWith(short.slice(0, Math.max(3, short.length - ending)));
}

const isOverdue = (task, todayKey, nowTime) =>
  task.status !== 'done' && Boolean(task.dueDate) && (task.dueDate < todayKey || (task.dueDate === todayKey && Boolean(task.dueTime) && task.dueTime <= nowTime));

const addDays = (key, days) => {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

/** Counts for the summary line: { total, todo, inProgress, done, overdue, dueToday }. */
function taskSummary(tasks, todayKey, nowTime = '00:00') {
  const list = Array.isArray(tasks) ? tasks : [];
  return {
    total: list.length,
    todo: list.filter((task) => task.status === 'todo').length,
    inProgress: list.filter((task) => task.status === 'inProgress').length,
    done: list.filter((task) => task.status === 'done').length,
    overdue: list.filter((task) => isOverdue(task, todayKey, nowTime)).length,
    dueToday: list.filter((task) => task.status !== 'done' && task.dueDate === todayKey).length,
  };
}

/**
 * `tasks`: current saved tasks. `pinnedIds`: tasks of this assistant session (kept first).
 * `options`: { categories, todayKey, nowTime } for group requests (overdue, category, plan ...).
 * Returns at most MAX_CONTEXT_TASKS entries with DETAIL_FIELDS, plus subtasks for named tasks.
 */
function selectTaskContext(message, tasks, pinnedIds = [], options = {}) {
  const list = Array.isArray(tasks) ? tasks.filter((task) => task && typeof task.id === 'string' && typeof task.title === 'string') : [];
  const byId = new Map(list.map((task) => [task.id, task]));
  const chosen = new Map(); // id -> { task, detail }
  const add = (task, detail) => {
    if (chosen.has(task.id) || chosen.size >= MAX_CONTEXT_TASKS) return;
    chosen.set(task.id, { task, detail });
  };
  for (const id of pinnedIds) if (byId.has(id)) add(byId.get(id), true);

  const words = tokens(message);
  if (words.length > 0) {
    const scored = list
      .filter((task) => !chosen.has(task.id))
      .map((task) => {
        const titleWords = tokens(task.title);
        return { task, score: words.filter((word) => titleWords.some((titleWord) => wordsMatch(word, titleWord))).length };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const { task } of scored) add(task, true);
  }

  // Group requests: the tasks the question or plan is about (without subtasks).
  const text = fold(message);
  const { todayKey } = options;
  const nowTime = options.nowTime ?? '00:00';
  const intents = new Set(INTENTS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name));
  const open = list.filter((task) => task.status !== 'done');
  const byDue = (a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || (a.dueTime ?? '').localeCompare(b.dueTime ?? '');
  if (todayKey) {
    if (intents.has('overdue') || intents.has('plan')) open.filter((task) => isOverdue(task, todayKey, nowTime)).sort(byDue).forEach((task) => add(task, false));
    if (intents.has('today') || intents.has('plan')) open.filter((task) => task.dueDate === todayKey).sort(byDue).forEach((task) => add(task, false));
    if (intents.has('soon') || intents.has('plan')) {
      const weekEnd = addDays(todayKey, 7);
      open.filter((task) => task.dueDate && task.dueDate >= todayKey && task.dueDate <= weekEnd).sort(byDue).forEach((task) => add(task, false));
    }
  }
  if (intents.has('plan') || intents.has('high')) open.filter((task) => task.priority === 'high').sort(byDue).forEach((task) => add(task, false));
  if (intents.has('done')) list.filter((task) => task.status === 'done').forEach((task) => add(task, false));
  if (intents.has('inProgress')) list.filter((task) => task.status === 'inProgress').forEach((task) => add(task, false));
  // Tasks with a tag the message names ("remove the tag urgent from ...", "переименуй метку учёба").
  const namesTag = (label) => {
    const tagWords = tokens(label);
    return tagWords.length > 0 && tagWords.every((tag) => words.some((word) => wordsMatch(word, tag)));
  };
  list.filter((task) => Array.isArray(task.labels) && task.labels.some(namesTag)).forEach((task) => add(task, false));
  for (const category of Array.isArray(options.categories) ? options.categories : []) {
    const nameWords = tokens(category.name);
    if (nameWords.length > 0 && nameWords.every((name) => words.some((word) => wordsMatch(word, name)))) {
      list.filter((task) => task.categoryId === category.id).sort(byDue).forEach((task) => add(task, false));
    }
  }

  return [...chosen.values()].map(({ task, detail }) => {
    const entry = Object.fromEntries(DETAIL_FIELDS.map((field) => [field, task[field] ?? null]));
    entry.reminders = Array.isArray(task.reminders) ? task.reminders : [];
    entry.labels = Array.isArray(task.labels) ? task.labels : [];
    if (detail) entry.subtasks = Array.isArray(task.subtasks) ? task.subtasks.map(({ id, title, done }) => ({ id, title, done })) : [];
    return entry;
  });
}

/** Existing tags (case-insensitive) with how many tasks carry each: [{ name, count }], most used first. */
function tagSummary(tasks) {
  const counts = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    for (const label of Array.isArray(task?.labels) ? task.labels : []) {
      if (typeof label !== 'string') continue;
      const key = label.toLocaleLowerCase();
      const entry = counts.get(key) ?? { name: label, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, MAX_TAGS);
}

module.exports = { selectTaskContext, taskSummary, tagSummary, MAX_CONTEXT_TASKS, tokens, wordsMatch };
