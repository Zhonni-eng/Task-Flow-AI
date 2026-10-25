// AI action-plan validation (src/ai/actionPlan.js): untrusted input in, structured results out.
// Covers every action type, dates/times/reminders/recurrence, category reuse, subtasks and
// parent-child rules, bulk filters resolved against real data, day plans, and references the
// provider was never shown.
import { describe, expect, it } from 'vitest';
import { MAX_ACTIONS, resolveBulkFilter, validateActionPlan } from '../../src/ai/actionPlan.js';
import { makeCategory, makeTask } from '../helpers/fixtures.js';

const NOW = new Date(2026, 9, 25, 12, 0); // Sunday 25 Oct 2026, 12:00 local
const sub = (id, title, done = false) => ({ id, title, done });
const tasks = [
  makeTask({ id: 't-report', title: 'Подготовить отчёт', status: 'todo', dueDate: '2026-10-25', estimateMinutes: 60 }),
  makeTask({ id: 't-bank', title: 'Call the bank', status: 'inProgress', dueDate: null, estimateMinutes: 30 }),
  makeTask({ id: 't-done', title: 'Купить ёлку', status: 'done', completedAt: '2026-08-01T10:00:00.000Z', categoryId: 'cat-study' }),
  makeTask({ id: 't-exam', title: 'Экзамен', dueDate: '2026-10-30', dueTime: '16:30', reminders: [30], subtasks: [sub('s1', 'Повторить ВВП'), sub('s2', 'Инфляция', true)], categoryId: 'cat-study' }),
  makeTask({ id: 't-late', title: 'Сдать эссе', dueDate: '2026-10-20', categoryId: 'cat-study' }),
  makeTask({ id: 't-rent', title: 'Оплатить аренду', dueDate: '2026-11-01', recurrence: { freq: 'monthly', interval: 1, monthDay: 1 } }),
];
const categories = [makeCategory({ id: 'cat-work', name: 'Работа' }), makeCategory({ id: 'cat-study', name: 'Учёба' })];
const context = { tasks, categories, now: NOW };
const one = (action, ctx = context) => validateActionPlan({ actions: [action] }, ctx);
const entry = (action, ctx) => one(action, ctx).actions[0];

describe('plan shape', () => {
  it.each([
    ['not an object', 'do it', 'invalidPlan'],
    ['no action list', { reply: 'ok' }, 'invalidActions'],
    ['injected plan fields', { actions: [], execute: 'rm -rf' }, 'unknownField'],
    ['too many actions', { actions: Array.from({ length: MAX_ACTIONS + 1 }, () => ({ type: 'none' })) }, 'tooManyActions'],
  ])('rejects %s', (_, plan, code) => {
    expect(validateActionPlan(plan, context).errors).toContain(code);
  });

  it.each([
    ['unknown types', { type: 'runCode' }, 'unknownType'],
    ['mutations of other things', { type: 'deleteCategory', categoryId: 'cat-work' }, 'unknownType'],
    ['injected fields on an action', { type: 'delete', taskId: 't-bank', sql: 'DROP' }, 'unknownField'],
  ])('rejects %s', (_, action, code) => {
    expect(entry(action).errors).toContain(code);
  });
});

describe('create', () => {
  it('normalizes a full new task: title, description, deadline, reminders, repeat, estimate, subtasks', () => {
    const result = entry({
      type: 'create',
      title: '  Подготовка к экзамену по экономике ',
      description: 'Повторить ключевые понятия и проверить знания.',
      dueDate: '2026-11-02',
      dueTime: '09:30',
      priority: 'high',
      reminders: [60, 1440],
      recurrence: { freq: 'weekly' },
      estimateMinutes: 120,
      categoryId: 'cat-study',
      subtasks: ['Повторить ВВП', ' изучить инфляцию ', 'Решить тесты'],
    });
    expect(result.valid).toBe(true);
    expect(result.normalized.fields).toEqual({
      title: 'Подготовка к экзамену по экономике',
      description: 'Повторить ключевые понятия и проверить знания.',
      priority: 'high',
      status: 'todo',
      dueDate: '2026-11-02',
      dueTime: '09:30',
      reminders: [60, 1440],
      recurrence: { freq: 'weekly', interval: 1, weekdays: [1] },
      estimateMinutes: 120,
      categoryId: 'cat-study',
      labels: [],
      subtasks: ['Повторить ВВП', 'изучить инфляцию', 'Решить тесты'],
    });
  });

  it('fills defaults for a minimal create action', () => {
    expect(entry({ type: 'create', title: 'Только название' }).normalized.fields).toMatchObject({
      title: 'Только название', description: '', priority: 'medium', status: 'todo', dueDate: null, dueTime: null, reminders: [], recurrence: null, estimateMinutes: null, categoryId: null, subtasks: [],
    });
  });

  it.each([
    ['missing title', { type: 'create' }, 'titleRequired'],
    ['too long title', { type: 'create', title: 'x'.repeat(121) }, 'titleTooLong'],
    ['invalid priority', { type: 'create', title: 'A', priority: 'urgent' }, 'invalidPriority'],
    ['status in another language', { type: 'create', title: 'A', status: 'Готово' }, 'invalidStatus'],
    ['an impossible date', { type: 'create', title: 'A', dueDate: '2026-02-30' }, 'invalidDate'],
    ['a time without a date', { type: 'create', title: 'A', dueTime: '16:30' }, 'timeWithoutDate'],
    ['an invalid time', { type: 'create', title: 'A', dueDate: '2026-11-01', dueTime: '25:00' }, 'invalidTime'],
    ['minute reminders without a time', { type: 'create', title: 'A', dueDate: '2026-11-01', reminders: [30] }, 'invalidReminders'],
    ['reminders without a date', { type: 'create', title: 'A', reminders: [1440] }, 'remindersWithoutDate'],
    ['a repeat without a date', { type: 'create', title: 'A', recurrence: { freq: 'daily' } }, 'recurrenceWithoutDate'],
    ['an unknown repeat', { type: 'create', title: 'A', dueDate: '2026-11-01', recurrence: { freq: 'hourly' } }, 'invalidRecurrence'],
    ['a zero estimate', { type: 'create', title: 'A', estimateMinutes: 0 }, 'invalidEstimate'],
    ['unknown category id', { type: 'create', title: 'A', categoryId: 'cat-missing' }, 'unknownCategory'],
    ['empty subtask', { type: 'create', title: 'A', subtasks: ['ok', '  '] }, 'invalidSubtasks'],
    ['subtask objects (no nesting)', { type: 'create', title: 'A', subtasks: [{ title: 'x', subtasks: [] }] }, 'invalidSubtasks'],
  ])('rejects %s', (_, action, code) => {
    const result = entry(action);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(code);
    expect(result.normalized).toBeNull();
  });

  it('flags likely duplicates of existing tasks and within the plan', () => {
    const result = validateActionPlan({ actions: [{ type: 'create', title: 'подготовить ОТЧЕТ' }, { type: 'create', title: 'Новая' }, { type: 'create', title: 'новая' }] }, context);
    expect(result.actions[0].warnings).toContain('possibleDuplicate');
    expect(result.actions[2].warnings).toContain('duplicateInPlan');
  });
});

describe('categories', () => {
  it.each([
    ['another case and ё/е', 'учеба', 'cat-study'],
    ['another word form', 'Учёбе', 'cat-study'],
    ['an English synonym', 'Study', 'cat-study'],
    ['an English synonym of another category', 'work', 'cat-work'],
  ])('a proposed new category that is %s reuses the existing one', (_, name, id) => {
    const result = entry({ type: 'create', title: 'A', newCategory: name });
    expect(result.normalized.fields.categoryId).toBe(id);
    expect(result.newCategory).toBeNull();
  });

  it('a genuinely new category is proposed (and shown) as new', () => {
    const result = entry({ type: 'create', title: 'A', newCategory: '  Путешествия ' });
    expect(result.normalized.newCategory).toBe('Путешествия');
    expect(result.normalized.fields.categoryId).toBeNull();
  });
});

describe('update', () => {
  it('changes only the given fields and reports the target task for the preview', () => {
    const result = entry({ type: 'update', taskId: 't-exam', changes: { dueDate: '2026-10-30', dueTime: '18:00', priority: 'high', title: 'Экзамен по экономике' } });
    expect(result.valid).toBe(true);
    expect(result.normalized.changes).toEqual({ dueDate: '2026-10-30', dueTime: '18:00', priority: 'high', title: 'Экзамен по экономике' });
    expect(result.target.id).toBe('t-exam');
  });

  it('"remove the due time but keep the date": minute reminders go with the time', () => {
    const result = entry({ type: 'update', taskId: 't-exam', changes: { dueTime: null } });
    expect(result.normalized.changes).toEqual({ dueTime: null, reminders: [] });
  });

  it('clearing the due date clears the time, reminders and repeat that depend on it', () => {
    expect(entry({ type: 'update', taskId: 't-rent', changes: { dueDate: null } }).normalized.changes).toEqual({ dueDate: null, dueTime: null, reminders: [], recurrence: null });
  });

  it('a time on a task without a date is rejected', () => {
    expect(entry({ type: 'update', taskId: 't-bank', changes: { dueTime: '10:00' } }).errors).toContain('timeWithoutDate');
  });

  it('flags changes that change nothing, and several actions on the same task', () => {
    expect(entry({ type: 'update', taskId: 't-report', changes: { status: 'todo' } }).warnings).toContain('noChange');
    const result = validateActionPlan(
      { actions: [{ type: 'update', taskId: 't-report', changes: { status: 'done' } }, { type: 'delete', taskId: 't-report' }] },
      context,
    );
    expect(result.actions[1].warnings).toContain('conflictsWithEarlier');
  });

  it('completing a repeating task says it moves on to the next occurrence', () => {
    expect(entry({ type: 'update', taskId: 't-rent', changes: { status: 'done' } }).warnings).toContain('advancesRecurrence');
  });

  it('earlier setStatus / setDueDate actions are accepted as updates', () => {
    expect(entry({ type: 'setStatus', taskId: 't-report', status: 'done' })).toMatchObject({ type: 'update', valid: true, normalized: { changes: { status: 'done' } } });
    expect(entry({ type: 'setDueDate', taskId: 't-report', dueDate: null })).toMatchObject({ type: 'update', valid: true });
  });

  it.each([
    ['no changes', { type: 'update', taskId: 't-report', changes: {} }, 'invalidChanges'],
    ['changing the id', { type: 'update', taskId: 't-report', changes: { id: 'x' } }, 'unknownField'],
    ['an unknown task', { type: 'update', taskId: 't-ghost', changes: { status: 'done' } }, 'unknownTask'],
  ])('rejects %s', (_, action, code) => {
    expect(entry(action).errors).toContain(code);
  });
});

describe('delete', () => {
  it('warns that subtasks are deleted with their parent, and a repeating task with all occurrences', () => {
    expect(entry({ type: 'delete', taskId: 't-exam' }).warnings).toContain('deletesSubtasks');
    expect(entry({ type: 'delete', taskId: 't-rent' }).warnings).toContain('deletesSeries');
  });
});

describe('subtasks', () => {
  it('add, complete/rename, delete and move between two existing tasks', () => {
    expect(entry({ type: 'addSubtask', taskId: 't-exam', title: 'Решить тесты' }).valid).toBe(true);
    expect(entry({ type: 'updateSubtask', taskId: 't-exam', subtaskId: 's1', done: true }).normalized.changes).toEqual({ done: true });
    expect(entry({ type: 'deleteSubtask', taskId: 't-exam', subtaskId: 's2' }).valid).toBe(true);
    expect(entry({ type: 'moveSubtask', taskId: 't-exam', subtaskId: 's1', toTaskId: 't-report' }).valid).toBe(true);
  });

  it.each([
    ['a subtask of another task', { type: 'updateSubtask', taskId: 't-report', subtaskId: 's1', done: true }, 'unknownSubtask'],
    ['moving a subtask into its own task', { type: 'moveSubtask', taskId: 't-exam', subtaskId: 's1', toTaskId: 't-exam' }, 'sameTask'],
    ['moving to a missing task', { type: 'moveSubtask', taskId: 't-exam', subtaskId: 's1', toTaskId: 't-ghost' }, 'unknownTask'],
    ['an update without changes', { type: 'updateSubtask', taskId: 't-exam', subtaskId: 's1' }, 'invalidChanges'],
    ['an empty title', { type: 'addSubtask', taskId: 't-exam', title: ' ' }, 'invalidSubtasks'],
  ])('rejects %s', (_, action, code) => {
    expect(entry(action).errors).toContain(code);
  });

  it('marking a done subtask done again changes nothing', () => {
    expect(entry({ type: 'updateSubtask', taskId: 't-exam', subtaskId: 's2', done: true }).warnings).toContain('noChange');
  });
});

describe('bulk changes (resolved by the app)', () => {
  it('"move all overdue tasks to tomorrow" finds exactly the overdue open tasks', () => {
    const result = entry({ type: 'bulk', operation: 'update', filter: { due: 'overdue' }, changes: { dueDate: '2026-10-26' } });
    expect(result.valid).toBe(true);
    expect(result.matches).toEqual(['t-late']);
    expect(result.normalized.changes).toEqual({ dueDate: '2026-10-26' });
  });

  it('"mark all Study tasks as completed" uses the category; done tasks are matched too, so it filters by status when asked', () => {
    expect(entry({ type: 'bulk', operation: 'update', filter: { categoryId: 'cat-study' }, changes: { status: 'done' } }).matches).toEqual(['t-done', 't-exam', 't-late']);
    expect(entry({ type: 'bulk', operation: 'update', filter: { categoryId: 'cat-study', status: 'todo' }, changes: { status: 'done' } }).matches).toEqual(['t-exam', 't-late']);
  });

  it('"delete completed tasks older than a month" uses the completion time', () => {
    const result = entry({ type: 'bulk', operation: 'delete', filter: { status: 'done', completedOlderThanDays: 30 } });
    expect(result.matches).toEqual(['t-done']);
  });

  it('a bulk change needs a criterion - never "all tasks" by omission', () => {
    expect(entry({ type: 'bulk', operation: 'delete', filter: {} }).errors).toContain('emptyFilter');
  });

  // Regression: "delete all tasks, including completed ones" produced an invalid action with 0 tasks.
  it('"delete all tasks, including completed" uses the explicit scope "all": every task, done ones too', () => {
    const result = entry({ type: 'bulk', operation: 'delete', filter: { scope: 'all' } });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.matches).toEqual(tasks.map((task) => task.id));
    expect(result.matches).toContain('t-done');
    expect(result.normalized).toMatchObject({ operation: 'delete', filter: { scope: 'all' } });
  });

  it('scope "all" combined with criteria still applies them; any other scope is invalid', () => {
    expect(entry({ type: 'bulk', operation: 'delete', filter: { scope: 'all', status: 'done' } }).matches).toEqual(['t-done']);
    expect(entry({ type: 'bulk', operation: 'delete', filter: { scope: 'everything' } }).errors).toContain('invalidFilter');
  });

  it('no matching tasks: valid but nothing to apply', () => {
    expect(entry({ type: 'bulk', operation: 'delete', filter: { titleContains: 'нет такого' } }).warnings).toContain('noMatches');
  });

  it.each([
    ['an unknown operation', { type: 'bulk', operation: 'archive', filter: { status: 'done' } }, 'invalidOperation'],
    ['an unknown filter value', { type: 'bulk', operation: 'delete', filter: { due: 'someday' } }, 'invalidFilter'],
    ['a field bulk changes cannot set', { type: 'bulk', operation: 'update', filter: { status: 'todo' }, changes: { title: 'Same' } }, 'unknownField'],
    ['an unknown category', { type: 'bulk', operation: 'delete', filter: { categoryId: 'cat-x' } }, 'unknownCategory'],
  ])('rejects %s', (_, action, code) => {
    expect(entry(action).errors).toContain(code);
  });

  it('resolveBulkFilter: a due time that passed today counts as overdue', () => {
    const list = [makeTask({ id: 'a', dueDate: '2026-10-25', dueTime: '09:00' }), makeTask({ id: 'b', dueDate: '2026-10-25', dueTime: '18:00' })];
    expect(resolveBulkFilter({ due: 'overdue' }, list, NOW).map((task) => task.id)).toEqual(['a']);
  });
});

describe('tags (labels)', () => {
  const tagged = [
    makeTask({ id: 'a', title: 'A', categoryId: 'cat-study', labels: ['срочно'] }),
    makeTask({ id: 'b', title: 'B', categoryId: 'cat-study', labels: [] }),
    makeTask({ id: 'c', title: 'C', categoryId: 'cat-work', labels: ['учёба'] }),
    makeTask({ id: 'full', title: 'Full', categoryId: 'cat-work', labels: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] }),
  ];
  const ctx = { tasks: tagged, categories, now: NOW };

  it('create: the new task gets the tags, normalized', () => {
    expect(entry({ type: 'create', title: 'X', labels: [' учёба ', 'Учёба', 'экзамен'] }, ctx).normalized.fields.labels).toEqual(['учёба', 'экзамен']);
  });

  it('bulk by category: adds tags to the matching tasks (done ones too)', () => {
    const result = entry({ type: 'bulk', operation: 'update', filter: { categoryId: 'cat-study' }, changes: { addLabels: ['учёба'] } }, ctx);
    expect(result.valid).toBe(true);
    expect(result.matches).toEqual(['a', 'b']);
    expect(result.normalized.changes).toEqual({ addLabels: ['учёба'] });
  });

  it('update: adding a tag the task already has (any case) is no change; a full task is warned about', () => {
    expect(entry({ type: 'update', taskId: 'c', changes: { addLabels: ['Учёба'] } }, ctx).warnings).toContain('noChange');
    expect(entry({ type: 'update', taskId: 'a', changes: { addLabels: ['учёба'] } }, ctx).warnings).not.toContain('noChange');
    expect(entry({ type: 'update', taskId: 'full', changes: { addLabels: ['11'] } }, ctx).warnings).toContain('labelLimit');
    expect(entry({ type: 'bulk', operation: 'update', filter: { categoryId: 'cat-work' }, changes: { addLabels: ['работа'] } }, ctx).warnings).toContain('labelLimit');
  });

  it.each([
    ['not a list', 'учёба'],
    ['an empty tag', ['  ']],
    ['a tag over 30 characters', ['x'.repeat(31)]],
    ['a non-string', [5]],
  ])('rejects %s', (_, addLabels) => {
    expect(entry({ type: 'update', taskId: 'a', changes: { addLabels } }, ctx).errors).toContain('invalidLabels');
  });
});

describe('tag management', () => {
  const tagged = [
    makeTask({ id: 'a', title: 'A', categoryId: 'cat-study', labels: ['Срочно', 'учёба'] }),
    makeTask({ id: 'b', title: 'B', categoryId: 'cat-study', labels: ['учёба'] }),
    makeTask({ id: 'c', title: 'C', categoryId: 'cat-work', labels: ['срочно'], status: 'done' }),
    makeTask({ id: 'd', title: 'D', categoryId: 'cat-work' }),
  ];
  const ctx = { tasks: tagged, categories, now: NOW };

  it('deleteLabel: every task with the tag (any case, done ones too); the tasks themselves are not deleted', () => {
    const result = entry({ type: 'deleteLabel', label: 'срочно' }, ctx);
    expect(result.valid).toBe(true);
    expect(result.matches).toEqual(['a', 'c']);
    expect(result.normalized).toEqual({ label: 'срочно', matches: ['a', 'c'] });
  });

  it('renameLabel: every task with the tag', () => {
    const result = entry({ type: 'renameLabel', label: 'учёба', newLabel: 'Study' }, ctx);
    expect(result.valid).toBe(true);
    expect(result.matches).toEqual(['a', 'b']);
    expect(result.normalized).toEqual({ label: 'учёба', newLabel: 'Study', matches: ['a', 'b'] });
  });

  it.each([
    ['a tag no task has', { type: 'deleteLabel', label: 'нет такой' }, 'unknownLabel'],
    ['an empty tag', { type: 'deleteLabel', label: ' ' }, 'invalidLabels'],
    ['a missing new name', { type: 'renameLabel', label: 'учёба', newLabel: '' }, 'invalidLabels'],
    ['a new name over 30 characters', { type: 'renameLabel', label: 'учёба', newLabel: 'x'.repeat(31) }, 'invalidLabels'],
    ['a task id (tags are global)', { type: 'deleteLabel', label: 'учёба', taskId: 'a' }, 'unknownField'],
  ])('rejects %s', (_, action, code) => {
    expect(entry(action, ctx).errors).toContain(code);
  });

  it('renaming a tag to the same name is no change', () => {
    expect(entry({ type: 'renameLabel', label: 'учёба', newLabel: 'учёба' }, ctx).warnings).toContain('noChange');
  });

  it('removeLabels on one task; removing a tag it does not have is no change', () => {
    const result = entry({ type: 'update', taskId: 'a', changes: { removeLabels: ['срочно'] } }, ctx);
    expect(result.valid).toBe(true);
    expect(result.warnings).not.toContain('noChange');
    expect(entry({ type: 'update', taskId: 'd', changes: { removeLabels: ['срочно'] } }, ctx).warnings).toContain('noChange');
  });

  it('bulk removeLabels by category affects only the tasks that have the tag', () => {
    const result = entry({ type: 'bulk', operation: 'update', filter: { categoryId: 'cat-work' }, changes: { removeLabels: ['срочно'] } }, ctx);
    expect(result.matches).toEqual(['c']);
    expect(entry({ type: 'bulk', operation: 'update', filter: { categoryId: 'cat-work' }, changes: { removeLabels: ['нет такой'] } }, ctx).warnings).toContain('noMatches');
  });

  it('adding and removing the same tag at once is rejected', () => {
    expect(entry({ type: 'update', taskId: 'a', changes: { addLabels: ['x'], removeLabels: ['X'] } }, ctx).errors).toContain('labelConflict');
  });
});

describe('day plans', () => {
  const plan = (items, availability = { start: '09:00', end: '18:00' }) => entry({ type: 'schedule', date: '2026-10-26', items }, { ...context, availability });

  it('a plan inside the availability with estimates is valid; items get their end time from the estimate', () => {
    const result = plan([{ taskId: 't-report', start: '09:00' }, { taskId: 't-bank', start: '10:00' }]);
    expect(result.valid).toBe(true);
    expect(result.normalized.items.map((item) => [item.taskId, item.start, item.endMin])).toEqual([['t-report', '09:00', 600], ['t-bank', '10:00', 630]]);
  });

  it.each([
    ['without availability (it must ask instead)', [{ taskId: 't-report', start: '09:00' }], null, 'noAvailability'],
    ['outside the availability', [{ taskId: 't-report', start: '17:30' }], undefined, 'outsideAvailability'],
    ['overlapping items', [{ taskId: 't-report', start: '09:00' }, { taskId: 't-bank', start: '09:30' }], undefined, 'overlap'],
    ['a completed task', [{ taskId: 't-done', start: '09:00' }], undefined, 'taskDone'],
    ['an invalid start time', [{ taskId: 't-report', start: '9am' }], undefined, 'invalidSchedule'],
  ])('rejects a plan %s', (_, items, availability, code) => {
    expect(plan(items, availability).errors).toContain(code);
  });

  it('a task without an estimate is allowed but flagged (no invented duration)', () => {
    expect(plan([{ taskId: 't-exam', start: '09:00' }]).warnings).toContain('noEstimate');
  });

  it('a plan for a past date is rejected', () => {
    expect(entry({ type: 'schedule', date: '2026-10-24', items: [{ taskId: 't-report', start: '09:00' }] }, { ...context, availability: { start: '09:00', end: '18:00' } }).errors).toContain('dateInPast');
  });
});

describe('references the provider was never shown', () => {
  it('changes are limited to tasks shared in this conversation', () => {
    const ctx = { ...context, allowedTaskIds: ['t-report'] };
    expect(entry({ type: 'update', taskId: 't-bank', changes: { status: 'done' } }, ctx).errors).toContain('notOffered');
    expect(entry({ type: 'delete', taskId: 't-bank' }, ctx).errors).toContain('notOffered');
    expect(entry({ type: 'update', taskId: 't-report', changes: { status: 'done' } }, ctx).valid).toBe(true);
  });

  it('references that cannot be checked are errors, never silently accepted', () => {
    expect(entry({ type: 'delete', taskId: 't-report' }, {}).errors).toContain('notVerified');
    expect(entry({ type: 'create', title: 'A', categoryId: 'cat-work' }, { tasks }).errors).toContain('notVerified');
    expect(entry({ type: 'bulk', operation: 'delete', filter: { status: 'done' } }, {}).errors).toContain('notVerified');
  });
});
