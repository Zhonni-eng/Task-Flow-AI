// Applying confirmed assistant plans (src/ai/applyPlan.js) and undoing them exactly.
// Pure functions on copies: validated entries in, whole-task snapshots out.
import { describe, expect, it } from 'vitest';
import { validateActionPlan } from '../../src/ai/actionPlan.js';
import { applyPlan, planUndo } from '../../src/ai/applyPlan.js';
import { tasksReducer, taskActions } from '../../src/state/tasksReducer.js';
import { makeCategory, makeTask } from '../helpers/fixtures.js';

const NOW = new Date(2026, 9, 25, 12, 0);
const sub = (id, title, done = false) => ({ id, title, done });
const base = () => [
  makeTask({ id: 'exam', title: 'Экзамен', dueDate: '2026-10-30', subtasks: [sub('s1', 'Повторить ВВП'), sub('s2', 'Инфляция', true)], order: 0 }),
  makeTask({ id: 'late', title: 'Сдать эссе', dueDate: '2026-10-20', order: 1 }),
  makeTask({ id: 'rent', title: 'Аренда', dueDate: '2026-11-01', recurrence: { freq: 'monthly', interval: 1, monthDay: 1 }, order: 2 }),
  makeTask({ id: 'old', title: 'Старое', status: 'done', completedAt: '2026-08-01T00:00:00.000Z' }),
];
const categories = [makeCategory({ id: 'cat-study', name: 'Учёба' })];
const run = (actions, tasks = base(), extra = {}) => {
  const validation = validateActionPlan({ actions }, { tasks, categories, now: NOW, ...extra });
  expect(validation.ok).toBe(true);
  return { outcome: applyPlan({ tasks, categories, entries: validation.actions, now: NOW }), tasks };
};
/** The board after an applied outcome (through the real reducer). */
const board = (tasks, outcome) => tasksReducer(tasks, taskActions.replace(outcome.tasks, outcome.removeIds));

describe('applying', () => {
  it('the economics exam example: main task, description and three actionable subtasks', () => {
    const { outcome } = run([
      {
        type: 'create',
        title: 'Подготовиться к экзамену по экономике',
        description: 'Подготовиться к экзамену: повторить ключевые понятия и проверить знания.',
        subtasks: ['Повторить ВВП', 'Изучить инфляцию', 'Решить практические тесты'],
        newCategory: 'учеба',
      },
    ]);
    const [task] = outcome.tasks;
    expect(task.title).toBe('Подготовиться к экзамену по экономике');
    expect(task.description).toMatch(/^Подготовиться к экзамену/);
    expect(task.subtasks.map((item) => [item.title, item.done])).toEqual([
      ['Повторить ВВП', false],
      ['Изучить инфляцию', false],
      ['Решить практические тесты', false],
    ]);
    // "учеба" matched the existing "Учёба": no duplicate category.
    expect(task.categoryId).toBe('cat-study');
    expect(outcome.categories).toEqual([]);
    expect(outcome.counts).toEqual({ created: 1, updated: 0, deleted: 0 });
  });

  it('a new category proposed twice in one plan is created once', () => {
    const { outcome } = run([
      { type: 'create', title: 'A', newCategory: 'Путешествия' },
      { type: 'create', title: 'B', newCategory: 'путешествия' },
    ]);
    expect(outcome.categories.map((category) => category.name)).toEqual(['Путешествия']);
    expect(new Set(outcome.tasks.map((task) => task.categoryId))).toEqual(new Set([outcome.categories[0].id]));
  });

  it('"Move my exam to Friday at 16:30" and "remove the due time but keep the date"', () => {
    const first = run([{ type: 'update', taskId: 'exam', changes: { dueDate: '2026-10-30', dueTime: '16:30' } }]);
    const moved = board(first.tasks, first.outcome);
    expect(moved.find((task) => task.id === 'exam')).toMatchObject({ dueDate: '2026-10-30', dueTime: '16:30' });
    const second = run([{ type: 'update', taskId: 'exam', changes: { dueTime: null } }], moved);
    expect(board(moved, second.outcome).find((task) => task.id === 'exam')).toMatchObject({ dueDate: '2026-10-30', dueTime: null });
  });

  it('completing a repeating task moves it to the next occurrence instead of Done', () => {
    const { outcome } = run([{ type: 'update', taskId: 'rent', changes: { status: 'done' } }]);
    expect(outcome.tasks[0]).toMatchObject({ status: 'todo', dueDate: '2026-12-01', completedAt: NOW.toISOString() });
  });

  it('"Move all overdue tasks to tomorrow" changes exactly the matched tasks', () => {
    const { outcome } = run([{ type: 'bulk', operation: 'update', filter: { due: 'overdue' }, changes: { dueDate: '2026-10-26' } }]);
    expect(outcome.tasks.map((task) => [task.id, task.dueDate])).toEqual([['late', '2026-10-26']]);
  });

  it('"Delete completed tasks older than a month" deletes only those', () => {
    const { outcome, tasks } = run([{ type: 'bulk', operation: 'delete', filter: { status: 'done', completedOlderThanDays: 30 } }]);
    expect(outcome.removeIds).toEqual(['old']);
    expect(board(tasks, outcome).map((task) => task.id).sort()).toEqual(['exam', 'late', 'rent']);
  });

  it('deleting a parent task deletes its subtasks with it (they live inside the task)', () => {
    const { outcome, tasks } = run([{ type: 'delete', taskId: 'exam' }]);
    const after = board(tasks, outcome);
    expect(after.some((task) => task.id === 'exam')).toBe(false);
    expect(after.flatMap((task) => task.subtasks).some((item) => item.id === 's1')).toBe(false);
  });

  it('subtasks: complete, rename, add, delete and move to another task (one level, ids kept)', () => {
    const { outcome } = run([
      { type: 'updateSubtask', taskId: 'exam', subtaskId: 's1', done: true, title: 'Повторить ВВП и ВНП' },
      { type: 'addSubtask', taskId: 'late', title: 'Вычитать текст' },
    ]);
    const exam = outcome.tasks.find((task) => task.id === 'exam');
    expect(exam.subtasks[0]).toEqual({ id: 's1', title: 'Повторить ВВП и ВНП', done: true });
    expect(outcome.tasks.find((task) => task.id === 'late').subtasks.map((item) => item.title)).toEqual(['Вычитать текст']);

    const moved = run([{ type: 'moveSubtask', taskId: 'exam', subtaskId: 's2', toTaskId: 'late' }]).outcome;
    expect(moved.tasks.find((task) => task.id === 'exam').subtasks.map((item) => item.id)).toEqual(['s1']);
    expect(moved.tasks.find((task) => task.id === 'late').subtasks).toEqual([{ id: 's2', title: 'Инфляция', done: true }]);
  });

  it('an accepted day plan sets planned slots, not deadlines', () => {
    const tasks = base().map((task) => (task.id === 'late' ? { ...task, estimateMinutes: 60 } : task));
    const { outcome } = run([{ type: 'schedule', date: '2026-10-26', items: [{ taskId: 'late', start: '10:00' }] }], tasks, { availability: { start: '09:00', end: '18:00' } });
    expect(outcome.tasks[0]).toMatchObject({ planned: { date: '2026-10-26', time: '10:00' }, dueDate: '2026-10-20' });
  });
});

describe('tags and "all tasks"', () => {
  it('adding tags keeps every existing tag (no duplicates) and Undo restores the old ones', () => {
    const tasks = [
      makeTask({ id: 'a', title: 'A', categoryId: 'cat-study', labels: ['срочно', 'Учёба'] }),
      makeTask({ id: 'b', title: 'B', categoryId: 'cat-study' }),
      makeTask({ id: 'c', title: 'C', labels: ['дом'] }),
    ];
    const { outcome } = run([{ type: 'bulk', operation: 'update', filter: { categoryId: 'cat-study' }, changes: { addLabels: ['учёба', 'вуз'] } }], tasks);
    const after = board(tasks, outcome);
    expect(after.map((task) => [task.id, task.labels])).toEqual([
      ['a', ['срочно', 'Учёба', 'вуз']],
      ['b', ['учёба', 'вуз']],
      ['c', ['дом']],
    ]);
    const result = planUndo(outcome.undo, after);
    const restored = tasksReducer(after, taskActions.replace(result.tasks, result.removeIds));
    expect(restored.map((task) => task.labels)).toEqual([['срочно', 'Учёба'], [], ['дом']]);
  });

  it('a new task gets its tags', () => {
    const { outcome } = run([{ type: 'create', title: 'Конспект', labels: ['учёба'] }]);
    expect(outcome.tasks[0].labels).toEqual(['учёба']);
  });

  it('deleting all tasks removes done ones too, and Undo brings every task back', () => {
    const { outcome, tasks } = run([{ type: 'bulk', operation: 'delete', filter: { scope: 'all' } }]);
    expect(outcome.counts.deleted).toBe(tasks.length);
    const after = board(tasks, outcome);
    expect(after).toEqual([]);
    const result = planUndo(outcome.undo, after);
    const restored = tasksReducer(after, taskActions.replace(result.tasks, result.removeIds));
    expect(restored.map((task) => task.id).sort()).toEqual(tasks.map((task) => task.id).sort());
  });
});

describe('tag management', () => {
  const tagged = () => [
    makeTask({ id: 'a', title: 'A', categoryId: 'cat-study', labels: ['Срочно', 'учёба'] }),
    makeTask({ id: 'b', title: 'B', categoryId: 'cat-study', labels: ['учёба', 'Study'] }),
    makeTask({ id: 'c', title: 'C', labels: ['срочно'], status: 'done', completedAt: '2026-10-01T00:00:00.000Z' }),
  ];
  const labelsAfter = (actions) => {
    const { outcome, tasks } = run(actions, tagged());
    const after = board(tasks, outcome);
    const result = planUndo(outcome.undo, after);
    const restored = tasksReducer(after, taskActions.replace(result.tasks, result.removeIds));
    return { after: after.map((task) => [task.id, task.labels]), restored: restored.map((task) => [task.id, task.labels]), before: tasks.map((task) => [task.id, task.labels]), outcome };
  };

  it('deleting a tag takes it off every task, keeps the tasks and their other tags; Undo restores it', () => {
    const { after, restored, before, outcome } = labelsAfter([{ type: 'deleteLabel', label: 'срочно' }]);
    expect(after).toEqual([['a', ['учёба']], ['b', ['учёба', 'Study']], ['c', []]]);
    expect(outcome.counts).toEqual({ created: 0, updated: 2, deleted: 0 });
    expect(restored).toEqual(before);
  });

  it('renaming a tag renames it everywhere and merges with an existing tag of that name; Undo restores', () => {
    const { after, restored, before } = labelsAfter([{ type: 'renameLabel', label: 'учёба', newLabel: 'study' }]);
    expect(after).toEqual([['a', ['Срочно', 'study']], ['b', ['study']], ['c', ['срочно']]]);
    expect(restored).toEqual(before);
  });

  it('removing a tag from one task leaves it on the others', () => {
    const { after, restored, before } = labelsAfter([{ type: 'update', taskId: 'a', changes: { removeLabels: ['срочно'] } }]);
    expect(after).toEqual([['a', ['учёба']], ['b', ['учёба', 'Study']], ['c', ['срочно']]]);
    expect(restored).toEqual(before);
  });

  it('bulk by category: add and remove tags in one change', () => {
    const { after } = labelsAfter([{ type: 'bulk', operation: 'update', filter: { categoryId: 'cat-study' }, changes: { addLabels: ['вуз'], removeLabels: ['учёба'] } }]);
    expect(after).toEqual([['a', ['Срочно', 'вуз']], ['b', ['Study', 'вуз']], ['c', ['срочно']]]);
  });
});

describe('undo', () => {
  it('reverts created, changed and deleted tasks exactly', () => {
    const { outcome, tasks } = run([
      { type: 'create', title: 'Новая' },
      { type: 'update', taskId: 'late', changes: { priority: 'high' } },
      { type: 'delete', taskId: 'exam' },
    ]);
    const after = board(tasks, outcome);
    const result = planUndo(outcome.undo, after);
    expect(result).toMatchObject({ removed: 1, restored: 2, kept: 0 });
    const restored = tasksReducer(after, taskActions.replace(result.tasks, result.removeIds));
    expect(restored.map((task) => [task.id, task.priority, task.subtasks.length]).sort()).toEqual(
      tasks.map((task) => [task.id, task.priority, task.subtasks.length]).sort(),
    );
  });

  it('keeps tasks the user edited after the assistant changed them, and says how many', () => {
    const { outcome, tasks } = run([{ type: 'update', taskId: 'late', changes: { priority: 'high' } }]);
    const edited = board(tasks, outcome).map((task) => (task.id === 'late' ? { ...task, title: 'Сдать эссе (правка)' } : task));
    expect(planUndo(outcome.undo, edited)).toMatchObject({ restored: 0, kept: 1, tasks: [] });
  });
});
