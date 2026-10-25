import { describe, expect, it } from 'vitest';
import {
  SUBTASK_LIMIT,
  SUBTASK_TITLE_LIMIT,
  createSubtask,
  normalizeSubtasks,
  subtaskProgress,
  validateSubtaskTitle,
} from '../../src/data/subtasks.js';
import { createTask, updateTask } from '../../src/data/taskModel.js';
import { ALL_TASKS, EMPTY_VIEW, buildBoardView, buildListView, computeStats, countByCategory } from '../../src/state/taskView.js';
import { restoreTasks, selectColumnTasks, taskActions, tasksReducer } from '../../src/state/tasksReducer.js';
import { FIXED_TODAY, makeTask } from '../helpers/fixtures.js';

const sub = (id, title, done = false) => ({ id, title, done });

describe('subtask model', () => {
  it('creates subtasks with unique stable ids and trimmed titles', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createSubtask('x').id));
    expect(ids.size).toBe(50);
    expect(createSubtask('  Повторить   лекции ')).toMatchObject({ title: 'Повторить лекции', done: false, id: expect.stringMatching(/^sub-/) });
  });

  it('rejects empty and whitespace-only titles', () => {
    expect(validateSubtaskTitle('')).toBe('subtaskRequired');
    expect(validateSubtaskTitle('   ')).toBe('subtaskRequired');
    expect(validateSubtaskTitle(null)).toBe('subtaskRequired');
    expect(validateSubtaskTitle('Ok')).toBeNull();
  });

  it('normalizes lists: drops invalid entries and duplicate ids, strips extra fields, never nests', () => {
    const list = normalizeSubtasks([
      sub('a', ' A '),
      { id: 'b', title: 'B', done: 'yes', subtasks: [sub('x', 'nested')], status: 'done' },
      sub('a', 'duplicate'),
      { title: 'no id' },
      sub('c', '   '),
      null,
    ]);
    expect(list).toEqual([sub('a', 'A'), sub('b', 'B', false)]);
    expect(normalizeSubtasks('not a list')).toEqual([]);
    expect(normalizeSubtasks(undefined)).toEqual([]);
  });

  it('enforces title length and the subtask limit', () => {
    expect(normalizeSubtasks([sub('a', 'x'.repeat(500))])[0].title).toHaveLength(SUBTASK_TITLE_LIMIT);
    const many = Array.from({ length: SUBTASK_LIMIT + 5 }, (_, i) => sub(`s${i}`, `t${i}`));
    expect(normalizeSubtasks(many)).toHaveLength(SUBTASK_LIMIT);
  });

  it('computes progress from actual completion states; null without subtasks', () => {
    expect(subtaskProgress(makeTask({ subtasks: [sub('a', 'A', true), sub('b', 'B'), sub('c', 'C', true)] }))).toEqual({ done: 2, total: 3 });
    expect(subtaskProgress(makeTask())).toBeNull();
    expect(subtaskProgress({})).toBeNull();
  });
});

describe('subtasks on tasks', () => {
  it('new tasks have no subtasks by default and keep provided ones', () => {
    expect(createTask({ title: 'Купить молоко' }).subtasks).toEqual([]);
    expect(createTask({ title: 'Экзамен', subtasks: [sub('a', 'Лекции')] }).subtasks).toEqual([sub('a', 'Лекции')]);
  });

  it('editing a task replaces its subtask list and keeps everything else', () => {
    const task = makeTask({ id: 't', labels: ['x'], subtasks: [sub('a', 'A')] });
    const updated = updateTask(task, { subtasks: [sub('a', 'A', true), sub('b', 'B')] });
    expect(updated.subtasks).toEqual([sub('a', 'A', true), sub('b', 'B')]);
    expect(updated).toMatchObject({ id: 't', labels: ['x'], status: 'todo', order: 0 });
  });

  it('editing other fields leaves subtasks untouched', () => {
    const task = makeTask({ subtasks: [sub('a', 'A', true)] });
    expect(updateTask(task, { title: 'New' }).subtasks).toEqual([sub('a', 'A', true)]);
  });

  it('restoring saved tasks keeps subtasks; tasks without the field get an empty list', () => {
    const [withSubs, legacy] = restoreTasks([makeTask({ id: 'a', subtasks: [sub('s', 'S', true)] }), { ...makeTask({ id: 'b' }), subtasks: undefined }]);
    expect(withSubs.subtasks).toEqual([sub('s', 'S', true)]);
    expect(legacy.subtasks).toEqual([]);
  });
});

describe('subtasks stay with their parent through every task operation', () => {
  const board = () => [
    makeTask({ id: 'p', title: 'Parent', order: 0, subtasks: [sub('s1', 'One', true), sub('s2', 'Two')] }),
    makeTask({ id: 'q', title: 'Other', order: 1 }),
    makeTask({ id: 'r', status: 'inProgress', order: 0, subtasks: [sub('r1', 'R')] }),
  ];
  const subsOf = (tasks, id) => tasks.find((task) => task.id === id).subtasks;

  it('reordering and moving between columns', () => {
    let tasks = tasksReducer(board(), taskActions.move('p', 'todo', 1));
    expect(selectColumnTasks(tasks, 'todo').map((task) => task.id)).toEqual(['q', 'p']);
    expect(subsOf(tasks, 'p')).toEqual([sub('s1', 'One', true), sub('s2', 'Two')]);
    tasks = tasksReducer(tasks, taskActions.move('p', 'done', 0));
    expect(subsOf(tasks, 'p')).toEqual([sub('s1', 'One', true), sub('s2', 'Two')]);
    expect(subsOf(tasks, 'r')).toEqual([sub('r1', 'R')]);
  });

  it('parent completion does not complete subtasks, and reopening does not reset them', () => {
    let tasks = tasksReducer(board(), taskActions.move('p', 'done', 0));
    expect(subsOf(tasks, 'p').map((s) => s.done)).toEqual([true, false]);
    tasks = tasksReducer(tasks, taskActions.move('p', 'todo', 0));
    expect(subsOf(tasks, 'p').map((s) => s.done)).toEqual([true, false]);
  });

  it('completing every subtask does not change the parent status', () => {
    const tasks = tasksReducer(board(), taskActions.update('p', { subtasks: [sub('s1', 'One', true), sub('s2', 'Two', true)] }));
    expect(tasks.find((task) => task.id === 'p').status).toBe('todo');
  });

  it('Stage 1 bulk actions keep subtasks attached', () => {
    let tasks = tasksReducer(board(), taskActions.bulkMove(['p', 'q'], 'done'));
    tasks = tasksReducer(tasks, taskActions.bulkUpdate(['p', 'r'], { priority: 'high', categoryId: 'c', dueDate: '2026-12-01' }));
    expect(subsOf(tasks, 'p')).toEqual([sub('s1', 'One', true), sub('s2', 'Two')]);
    expect(subsOf(tasks, 'r')).toEqual([sub('r1', 'R')]);
    expect(subsOf(tasks, 'q')).toEqual([]);
  });

  it('deleting a parent removes its subtasks with it and nothing else', () => {
    const single = tasksReducer(board(), taskActions.remove('p'));
    expect(single.map((task) => task.id)).toEqual(['q', 'r']);
    expect(subsOf(single, 'r')).toEqual([sub('r1', 'R')]);
    const bulk = tasksReducer(board(), taskActions.bulkRemove(['p', 'r']));
    expect(bulk.map((task) => task.id)).toEqual(['q']);
    expect(JSON.stringify(bulk)).not.toContain('s1');
  });
});

describe('subtasks are never top-level tasks', () => {
  const tasks = [
    makeTask({ id: 'p', title: 'Подготовка к экзамену', subtasks: [sub('s1', 'Решить задачи', true), sub('s2', 'Повторить лекции')] }),
    makeTask({ id: 'q', title: 'Купить молоко', status: 'done' }),
  ];

  it('board, list, counts and statistics only count parent tasks', () => {
    expect(buildBoardView(tasks, EMPTY_VIEW, 'ru').shown).toBe(2);
    expect(buildListView(tasks, EMPTY_VIEW, 'ru')).toHaveLength(2);
    expect(countByCategory(tasks)[ALL_TASKS]).toBe(2);
    expect(computeStats(tasks, FIXED_TODAY)).toEqual({ total: 2, done: 1, overdue: 0, percent: 50 });
  });

  it('searching for a subtask title does not return it as a task', () => {
    expect(buildListView(tasks, { ...EMPTY_VIEW, query: 'Решить задачи' }, 'ru')).toEqual([]);
    expect(buildListView(tasks, { ...EMPTY_VIEW, query: 'экзамен' }, 'ru').map((task) => task.id)).toEqual(['p']);
  });
});
