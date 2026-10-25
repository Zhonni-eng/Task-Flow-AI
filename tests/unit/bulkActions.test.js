import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { selectColumnTasks, taskActions, tasksReducer } from '../../src/state/tasksReducer.js';
import { useSelection } from '../../src/state/useSelection.js';
import { makeTask } from '../helpers/fixtures.js';

const column = (tasks, status) => selectColumnTasks(tasks, status).map((task) => `${task.id}:${task.order}`);
const byId = (tasks, id) => tasks.find((task) => task.id === id);

function board() {
  return [
    makeTask({ id: 'a', status: 'todo', order: 0, description: 'keep me', labels: ['x'], categoryId: 'work' }),
    makeTask({ id: 'b', status: 'todo', order: 1 }),
    makeTask({ id: 'c', status: 'todo', order: 2 }),
    makeTask({ id: 'd', status: 'inProgress', order: 0 }),
    makeTask({ id: 'e', status: 'done', order: 0 }),
  ];
}

describe('bulk move', () => {
  it('appends moved tasks to the end of the target column in display order and renumbers sources', () => {
    const next = tasksReducer(board(), taskActions.bulkMove(['c', 'a'], 'done'));
    expect(column(next, 'done')).toEqual(['e:0', 'a:1', 'c:2']);
    expect(column(next, 'todo')).toEqual(['b:0']);
    expect(column(next, 'inProgress')).toEqual(['d:0']);
  });

  it('moves tasks from different columns and keeps tasks already in the target in place', () => {
    const next = tasksReducer(board(), taskActions.bulkMove(['d', 'b', 'e'], 'done'));
    expect(column(next, 'done')).toEqual(['e:0', 'b:1', 'd:2']);
    expect(column(next, 'inProgress')).toEqual([]);
  });

  it('keeps every unrelated field of moved tasks', () => {
    const state = board();
    const before = byId(state, 'a');
    const after = byId(tasksReducer(state, taskActions.bulkMove(['a'], 'inProgress')), 'a');
    expect(after).toMatchObject({ id: 'a', title: before.title, description: 'keep me', labels: ['x'], categoryId: 'work', createdAt: before.createdAt, status: 'inProgress' });
  });

  it('returns the same state when nothing moves or ids are unknown', () => {
    const state = board();
    expect(tasksReducer(state, taskActions.bulkMove(['e'], 'done'))).toBe(state);
    expect(tasksReducer(state, taskActions.bulkMove(['ghost'], 'done'))).toBe(state);
    expect(tasksReducer(state, taskActions.bulkMove([], 'done'))).toBe(state);
  });
});

describe('bulk update', () => {
  it('changes only the given field on the given tasks', () => {
    const state = board();
    const next = tasksReducer(state, taskActions.bulkUpdate(['a', 'c'], { priority: 'high' }));
    expect(byId(next, 'a').priority).toBe('high');
    expect(byId(next, 'c').priority).toBe('high');
    expect(byId(next, 'b')).toBe(byId(state, 'b'));
    expect(byId(next, 'a')).toMatchObject({ description: 'keep me', labels: ['x'], order: 0, status: 'todo' });
  });

  it('assigns and clears categories and due dates', () => {
    let next = tasksReducer(board(), taskActions.bulkUpdate(['a', 'b'], { categoryId: 'home' }));
    expect([byId(next, 'a').categoryId, byId(next, 'b').categoryId]).toEqual(['home', 'home']);
    next = tasksReducer(next, taskActions.bulkUpdate(['a'], { categoryId: null }));
    expect(byId(next, 'a').categoryId).toBeNull();
    next = tasksReducer(next, taskActions.bulkUpdate(['b', 'c'], { dueDate: '2026-11-15' }));
    expect([byId(next, 'b').dueDate, byId(next, 'c').dueDate]).toEqual(['2026-11-15', '2026-11-15']);
    next = tasksReducer(next, taskActions.bulkUpdate(['b'], { dueDate: null }));
    expect(byId(next, 'b').dueDate).toBeNull();
  });

  it('ignores fields that bulk actions may not change and invalid values', () => {
    const state = board();
    const next = tasksReducer(state, taskActions.bulkUpdate(['a'], { title: 'hacked', status: 'done', order: 9 }));
    expect(next).toBe(state);
    const invalid = tasksReducer(state, taskActions.bulkUpdate(['a'], { dueDate: '2026-02-30', priority: 'urgent' }));
    expect(byId(invalid, 'a')).toMatchObject({ dueDate: null, priority: 'medium' });
  });

  it('does not touch tasks whose value is already the requested one', () => {
    const state = board();
    expect(tasksReducer(state, taskActions.bulkUpdate(['b', 'c'], { priority: 'medium' }))).toBe(state);
  });
});

describe('bulk delete', () => {
  it('removes the tasks and renumbers each affected column', () => {
    const next = tasksReducer(board(), taskActions.bulkRemove(['a', 'd']));
    expect(next.map((task) => task.id).sort()).toEqual(['b', 'c', 'e']);
    expect(column(next, 'todo')).toEqual(['b:0', 'c:1']);
    expect(column(next, 'inProgress')).toEqual([]);
  });

  it('returns the same state for unknown ids', () => {
    const state = board();
    expect(tasksReducer(state, taskActions.bulkRemove(['ghost']))).toBe(state);
  });
});

describe('useSelection', () => {
  const setup = (visible = ['a', 'b', 'c'], context = 'all|list') =>
    renderHook(({ ids, key }) => useSelection(ids, key), { initialProps: { ids: visible, key: context } });

  it('toggles individual ids and counts them', () => {
    const { result } = setup();
    act(() => result.current.toggle('a'));
    act(() => result.current.toggle('c'));
    expect(result.current.selectedIds).toEqual(['a', 'c']);
    expect(result.current.count).toBe(2);
    expect(result.current.someSelected).toBe(true);
    act(() => result.current.toggle('a'));
    expect(result.current.selectedIds).toEqual(['c']);
  });

  it('select-all selects exactly the visible ids and toggles off when all are selected', () => {
    const { result } = setup(['b', 'c']);
    act(() => result.current.toggleAll());
    expect(result.current.selectedIds).toEqual(['b', 'c']);
    expect(result.current.allSelected).toBe(true);
    act(() => result.current.toggleAll());
    expect(result.current.count).toBe(0);
  });

  it('drops ids that stop being visible and does not bring them back', () => {
    const { result, rerender } = setup();
    act(() => result.current.toggleAll());
    rerender({ ids: ['a'], key: 'all|list' });
    expect(result.current.selectedIds).toEqual(['a']);
    rerender({ ids: ['a', 'b', 'c'], key: 'all|list' });
    expect(result.current.selectedIds).toEqual(['a']);
  });

  it('keeps the selection when only the order changes (sorting)', () => {
    const { result, rerender } = setup(['a', 'b', 'c']);
    act(() => result.current.toggle('b'));
    rerender({ ids: ['c', 'b', 'a'], key: 'all|list' });
    expect(result.current.selectedIds).toEqual(['b']);
  });

  it('clears when the context (category or layout) changes', () => {
    const { result, rerender } = setup();
    act(() => result.current.toggleAll());
    rerender({ ids: ['a', 'b', 'c'], key: 'work|list' });
    expect(result.current.count).toBe(0);
  });

  it('clear() empties the selection', () => {
    const { result } = setup();
    act(() => result.current.toggleAll());
    act(() => result.current.clear());
    expect(result.current.count).toBe(0);
  });
});
