import { describe, expect, it } from 'vitest';
import {
  ALL_TASKS,
  EMPTY_VIEW,
  UNCATEGORIZED,
  buildBoardView,
  buildListView,
  computeStats,
  countByCategory,
  isDragAllowed,
  isFiltering,
  normalizeQuery,
  scopeTasks,
  toFullColumnIndex,
} from '../../src/state/taskView.js';
import { selectColumnTasks, taskActions, tasksReducer } from '../../src/state/tasksReducer.js';
import { FIXED_TODAY, makeTask } from '../helpers/fixtures.js';

const view = (overrides = {}) => ({ ...EMPTY_VIEW, ...overrides });
const titles = (tasks) => tasks.map((task) => task.title);
const visibleTitles = (boardView) => Object.values(boardView.columns).flat().map((task) => task.title);

function sample() {
  return [
    makeTask({ id: 'a', title: 'Ёлка к празднику', description: 'Купить игрушки', priority: 'high', dueDate: '2026-10-25', labels: ['Дом'], order: 0 }),
    makeTask({ id: 'b', title: 'Write report', description: 'Quarterly NUMBERS', priority: 'low', labels: ['work', 'Urgent'], order: 1 }),
    makeTask({ id: 'c', title: 'Отчёт 10', status: 'inProgress', priority: 'high', dueDate: '2026-10-20', order: 0 }),
    makeTask({ id: 'd', title: 'Отчёт 9', status: 'inProgress', priority: 'low', dueDate: '2026-10-30', order: 1 }),
    makeTask({ id: 'e', title: 'Done thing', status: 'done', dueDate: '2026-01-01', labels: ['work'], order: 0 }),
  ];
}

describe('search', () => {
  it('normalizes the query', () => {
    expect(normalizeQuery('  ЁЛКА   к ')).toBe('елка к');
  });

  it('matches titles case-insensitively, with ё = е and trimmed spaces', () => {
    expect(visibleTitles(buildBoardView(sample(), view({ query: '  елка ' }), 'ru'))).toEqual(['Ёлка к празднику']);
  });

  it('matches descriptions', () => {
    expect(visibleTitles(buildBoardView(sample(), view({ query: 'numbers' }), 'en'))).toEqual(['Write report']);
  });

  it('matches upper-case Russian', () => {
    expect(buildBoardView(sample(), view({ query: 'ОТЧЁТ' }), 'ru').shown).toBe(2);
  });

  it('treats a blank query as no filter', () => {
    expect(isFiltering(view({ query: '   ' }))).toBe(false);
    expect(buildBoardView(sample(), view({ query: '   ' }), 'ru').shown).toBe(5);
  });

  it('returns no results without changing totals', () => {
    const result = buildBoardView(sample(), view({ query: 'zzz' }), 'ru');
    expect(result.shown).toBe(0);
    expect(result.total).toBe(5);
    expect(result.totals).toEqual({ todo: 2, inProgress: 2, done: 1 });
  });
});

describe('filters', () => {
  it('filters by status', () => {
    expect(visibleTitles(buildBoardView(sample(), view({ statuses: ['done'] }), 'ru'))).toEqual(['Done thing']);
  });

  it('filters by priority', () => {
    expect(buildBoardView(sample(), view({ priorities: ['high'] }), 'ru').shown).toBe(2);
  });

  it('filters by labels case-insensitively (any selected label matches)', () => {
    const result = buildBoardView(sample(), view({ labels: ['WORK', 'дом'] }), 'ru');
    expect(visibleTitles(result).sort()).toEqual(['Done thing', 'Write report', 'Ёлка к празднику'].sort());
  });

  it('combines search and filters with AND across groups', () => {
    expect(visibleTitles(buildBoardView(sample(), view({ query: 'отчёт', priorities: ['high'] }), 'ru'))).toEqual(['Отчёт 10']);
  });

  it('never mutates the task collection', () => {
    const tasks = sample();
    const snapshot = JSON.stringify(tasks);
    buildBoardView(tasks, view({ sort: 'title', query: 'x', labels: ['work'] }), 'ru');
    buildListView(tasks, view({ sort: 'priority' }), 'ru');
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });
});

describe('sorting', () => {
  const column = (sort, status) => titles(buildBoardView(sample(), view({ sort }), 'ru').columns[status]);

  it('keeps manual order by default', () => {
    expect(column('manual', 'todo')).toEqual(['Ёлка к празднику', 'Write report']);
  });

  it('sorts by due date with undated tasks last (ties keep manual order)', () => {
    const tasks = [makeTask({ title: 'x', order: 1 }), makeTask({ title: 'y', order: 0 }), makeTask({ title: 'z', dueDate: '2026-12-01', order: 2 })];
    expect(titles(buildBoardView(tasks, view({ sort: 'dueDate' }), 'ru').columns.todo)).toEqual(['z', 'y', 'x']);
    expect(column('dueDate', 'inProgress')).toEqual(['Отчёт 10', 'Отчёт 9']);
  });

  it('sorts by priority, high first', () => {
    expect(column('priority', 'inProgress')).toEqual(['Отчёт 10', 'Отчёт 9']);
    expect(column('priority', 'todo')).toEqual(['Ёлка к празднику', 'Write report']);
  });

  it('sorts titles with the locale collator and numeric awareness', () => {
    expect(column('title', 'inProgress')).toEqual(['Отчёт 9', 'Отчёт 10']);
  });

  it('only allows drag-and-drop on the complete board in manual order', () => {
    expect(isDragAllowed(view())).toBe(true);
    expect(isDragAllowed(view({ sort: 'title' }))).toBe(false);
    expect(isDragAllowed(view({ query: 'x' }))).toBe(false);
    expect(isDragAllowed(view({ labels: ['a'] }))).toBe(false);
  });
});

describe('list ordering', () => {
  const tasks = [
    makeTask({ id: 't2', title: 't2', order: 1 }),
    makeTask({ id: 'd1', title: 'd1', status: 'done', dueDate: '2026-01-02' }),
    makeTask({ id: 'p1', title: 'p1', status: 'inProgress', dueDate: '2026-01-01' }),
    makeTask({ id: 't1', title: 't1', order: 0, dueDate: '2026-01-05' }),
  ];

  it('groups by status then manual order', () => {
    expect(titles(buildListView(tasks, view(), 'ru'))).toEqual(['t1', 't2', 'p1', 'd1']);
  });

  it('sorts across statuses for other modes', () => {
    expect(titles(buildListView(tasks, view({ sort: 'dueDate' }), 'ru'))).toEqual(['p1', 'd1', 't1', 't2']);
  });

  it('applies search and filters', () => {
    expect(titles(buildListView(tasks, view({ statuses: ['done', 'inProgress'] }), 'ru'))).toEqual(['p1', 'd1']);
  });
});

describe('statistics', () => {
  it('counts total, done, overdue (excluding done) and percent', () => {
    expect(computeStats(sample(), FIXED_TODAY)).toEqual({ total: 5, done: 1, overdue: 1, percent: 20 });
  });

  it('reports null percent for zero tasks', () => {
    expect(computeStats([], FIXED_TODAY)).toEqual({ total: 0, done: 0, overdue: 0, percent: null });
  });

  it('counts duplicate ids once and does not treat today as overdue', () => {
    const today = makeTask({ id: 'today', dueDate: '2026-10-21' });
    expect(computeStats([today, today], new Date(2026, 9, 21))).toEqual({ total: 1, done: 0, overdue: 0, percent: 0 });
  });
});

describe('category scope and counts', () => {
  const pool = [
    makeTask({ id: '1', categoryId: 'X' }),
    makeTask({ id: '2' }),
    makeTask({ id: '3', categoryId: 'Y', status: 'done' }),
    makeTask({ id: '4', categoryId: 'X' }),
  ];

  it('scopes to all, uncategorized or one category', () => {
    expect(scopeTasks(pool, ALL_TASKS)).toHaveLength(4);
    expect(scopeTasks(pool, UNCATEGORIZED).map((task) => task.id)).toEqual(['2']);
    expect(scopeTasks(pool, 'X').map((task) => task.id)).toEqual(['1', '4']);
    expect(scopeTasks(pool, 'missing')).toEqual([]);
  });

  it('counts tasks per destination', () => {
    expect(countByCategory(pool)).toEqual({ [ALL_TASKS]: 4, [UNCATEGORIZED]: 1, X: 2, Y: 1 });
    expect(countByCategory([])).toEqual({ [ALL_TASKS]: 0, [UNCATEGORIZED]: 0 });
  });
});

describe('category-scoped drag positions', () => {
  const full = ['a', 'b', 'c', 'd', 'e'];

  it('places a task before the visible task that follows it', () => {
    expect(toFullColumnIndex(full, ['b', 'd'], 'd', 0)).toBe(1);
  });

  it('places a task after the visible task that precedes it', () => {
    expect(toFullColumnIndex(full, ['b', 'd'], 'b', 1)).toBe(3);
  });

  it('goes to the end of the full column when the scoped column is empty', () => {
    expect(toFullColumnIndex(['x', 'y'], [], 'q', 0)).toBe(2);
  });

  it('is the identity when nothing is hidden', () => {
    expect(toFullColumnIndex(full, full, 'e', 1)).toBe(1);
    expect(toFullColumnIndex(full, full, 'a', 3)).toBe(3);
  });

  it('keeps hidden tasks in their relative order through the reducer', () => {
    let tasks = full.map((id, order) => makeTask({ id, order, categoryId: id === 'b' || id === 'd' ? 'X' : null }));
    tasks = tasksReducer(tasks, taskActions.move('d', 'todo', toFullColumnIndex(full, ['b', 'd'], 'd', 0)));
    expect(selectColumnTasks(tasks, 'todo').map((task) => task.id)).toEqual(['a', 'd', 'b', 'c', 'e']);
  });
});
