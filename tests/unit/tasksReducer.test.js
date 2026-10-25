import { describe, expect, it } from 'vitest';
import {
  collectLabels,
  compareTasks,
  restoreTasks,
  selectColumnTasks,
  taskActions,
  tasksReducer,
} from '../../src/state/tasksReducer.js';
import { makeTask } from '../helpers/fixtures.js';

const ids = (tasks, status) => selectColumnTasks(tasks, status).map((task) => task.id);
const orders = (tasks, status) => selectColumnTasks(tasks, status).map((task) => task.order);

function board() {
  return [
    makeTask({ id: 'a', status: 'todo', order: 0 }),
    makeTask({ id: 'b', status: 'todo', order: 1 }),
    makeTask({ id: 'c', status: 'todo', order: 2 }),
    makeTask({ id: 'd', status: 'inProgress', order: 0 }),
    makeTask({ id: 'e', status: 'done', order: 0 }),
  ];
}

describe('ordering', () => {
  it('sorts by order, then creation time, then id', () => {
    const x = makeTask({ id: 'x', order: 1, createdAt: '2026-01-02' });
    const y = makeTask({ id: 'y', order: 1, createdAt: '2026-01-01' });
    const z = makeTask({ id: 'z', order: 0 });
    expect([x, y, z].sort(compareTasks).map((task) => task.id)).toEqual(['z', 'y', 'x']);
  });

  it('restoreTasks renumbers every column to contiguous orders', () => {
    const restored = restoreTasks([
      makeTask({ id: 'a', order: 10 }),
      makeTask({ id: 'b', order: 3 }),
      makeTask({ id: 'c', status: 'done', order: 7 }),
    ]);
    expect(ids(restored, 'todo')).toEqual(['b', 'a']);
    expect(orders(restored, 'todo')).toEqual([0, 1]);
    expect(orders(restored, 'done')).toEqual([0]);
  });
});

describe('create / update / delete', () => {
  it('adds new tasks at the top of their column', () => {
    const next = tasksReducer(board(), taskActions.create({ title: 'New' }));
    const column = selectColumnTasks(next, 'todo');
    expect(column[0].title).toBe('New');
    expect(column.map((task) => task.order)).toEqual([0, 1, 2, 3]);
  });

  it('updates a task in place without duplicating it', () => {
    const next = tasksReducer(board(), taskActions.update('b', { title: 'Renamed', priority: 'high' }));
    expect(next).toHaveLength(5);
    expect(next.find((task) => task.id === 'b')).toMatchObject({ title: 'Renamed', priority: 'high', order: 1 });
  });

  it('deletes a task and renumbers its column', () => {
    const next = tasksReducer(board(), taskActions.remove('a'));
    expect(ids(next, 'todo')).toEqual(['b', 'c']);
    expect(orders(next, 'todo')).toEqual([0, 1]);
  });

  it('returns the same state for unknown ids and actions', () => {
    const state = board();
    expect(tasksReducer(state, taskActions.remove('missing'))).toBe(state);
    expect(tasksReducer(state, taskActions.move('missing', 'done', 0))).toBe(state);
    expect(tasksReducer(state, { type: 'unknown' })).toBe(state);
  });
});

describe('move', () => {
  it('reorders within a column', () => {
    const next = tasksReducer(board(), taskActions.move('c', 'todo', 0));
    expect(ids(next, 'todo')).toEqual(['c', 'a', 'b']);
    expect(orders(next, 'todo')).toEqual([0, 1, 2]);
  });

  it('moves between columns, keeps data and renumbers both columns', () => {
    const state = board();
    const before = state.find((task) => task.id === 'b');
    const next = tasksReducer(state, taskActions.move('b', 'done', 1));
    const moved = next.find((task) => task.id === 'b');
    expect(ids(next, 'todo')).toEqual(['a', 'c']);
    expect(ids(next, 'done')).toEqual(['e', 'b']);
    expect(orders(next, 'todo')).toEqual([0, 1]);
    expect(moved).toMatchObject({ id: 'b', title: before.title, labels: before.labels, status: 'done' });
  });

  it('clamps out-of-range indexes to the column end', () => {
    expect(ids(tasksReducer(board(), taskActions.move('a', 'inProgress', 99)), 'inProgress')).toEqual(['d', 'a']);
  });

  it('is a no-op (same state object) when dropped in place', () => {
    const state = board();
    expect(tasksReducer(state, taskActions.move('b', 'todo', 1))).toBe(state);
  });
});

describe('category reassignment', () => {
  const tasks = [makeTask({ id: '1', categoryId: 'x' }), makeTask({ id: '2', categoryId: 'y' }), makeTask({ id: '3', categoryId: 'x' })];

  it('moves every task of a category to another category', () => {
    const next = tasksReducer(tasks, taskActions.reassignCategory('x', 'y'));
    expect(next.map((task) => task.categoryId)).toEqual(['y', 'y', 'y']);
  });

  it('moves tasks to uncategorized and never deletes them', () => {
    const next = tasksReducer(tasks, taskActions.reassignCategory('x', null));
    expect(next).toHaveLength(3);
    expect(next.map((task) => task.categoryId)).toEqual([null, 'y', null]);
  });

  it('returns the same state when the category has no tasks', () => {
    expect(tasksReducer(tasks, taskActions.reassignCategory('none', null))).toBe(tasks);
  });
});

describe('collectLabels', () => {
  it('returns distinct labels, first spelling wins', () => {
    const tasks = [makeTask({ labels: ['Design', 'UI'] }), makeTask({ labels: ['design', 'Bug'] })];
    expect(collectLabels(tasks)).toEqual(['Design', 'UI', 'Bug']);
  });
});
