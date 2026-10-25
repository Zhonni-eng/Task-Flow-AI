// Due-date states, date filters, quick due dates and local-calendar boundaries.
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DUE_FILTERS, dueState, matchesDueFilter } from '../../src/data/dueDates.js';
import { tasksReducer } from '../../src/state/tasksReducer.js';
import {
  ALL_TASKS,
  EMPTY_VIEW,
  buildBoardView,
  buildListView,
  computeStats,
  isDragAllowed,
  isFiltering,
  matchesView,
  scopeTasks,
} from '../../src/state/taskView.js';
import { useToday } from '../../src/state/useToday.js';
import { QUICK_DATES, quickDate, startOfNextWeek, startOfToday, toDateKey } from '../../src/utils/date.js';
import { FIXED_TODAY, makeTask } from '../helpers/fixtures.js';

const TODAY = new Date(2026, 9, 21); // Wednesday 21 Oct 2026
const view = (overrides = {}) => ({ ...EMPTY_VIEW, ...overrides });
const keys = (dates) => dates.map((date) => toDateKey(date));

describe('due state', () => {
  it('distinguishes overdue, today, tomorrow and later dates', () => {
    expect(dueState(makeTask({ dueDate: '2026-10-20' }), TODAY)).toBe('overdue');
    expect(dueState(makeTask({ dueDate: '2025-12-31' }), TODAY)).toBe('overdue');
    expect(dueState(makeTask({ dueDate: '2026-10-21' }), TODAY)).toBe('today');
    expect(dueState(makeTask({ dueDate: '2026-10-22' }), TODAY)).toBe('tomorrow');
    expect(dueState(makeTask({ dueDate: '2026-10-23' }), TODAY)).toBe('upcoming');
    expect(dueState(makeTask({ dueDate: '2027-01-01' }), TODAY)).toBe('upcoming');
  });

  it('completed tasks are never overdue, whatever their date', () => {
    for (const dueDate of ['2026-01-01', '2026-10-21', '2026-12-01']) {
      expect(dueState(makeTask({ dueDate, status: 'done' }), TODAY)).toBe('done');
    }
    // In progress is not completed.
    expect(dueState(makeTask({ dueDate: '2026-10-01', status: 'inProgress' }), TODAY)).toBe('overdue');
  });

  it('tasks without a valid due date are neutral', () => {
    expect(dueState(makeTask({ dueDate: null }), TODAY)).toBe('none');
    expect(dueState(makeTask({ dueDate: '2026-02-30' }), TODAY)).toBe('none');
    expect(dueState(makeTask({ dueDate: 'tomorrow' }), TODAY)).toBe('none');
  });

  it('crosses month and year ends by calendar date', () => {
    const newYearsEve = new Date(2026, 11, 31);
    expect(dueState(makeTask({ dueDate: '2027-01-01' }), newYearsEve)).toBe('tomorrow');
    expect(dueState(makeTask({ dueDate: '2026-12-30' }), newYearsEve)).toBe('overdue');
    expect(dueState(makeTask({ dueDate: '2026-03-01' }), new Date(2026, 1, 28))).toBe('tomorrow');
  });

  it('uses the current local date by default', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_TODAY);
    try {
      expect(dueState(makeTask({ dueDate: '2026-10-21' }))).toBe('today');
      expect(dueState(makeTask({ dueDate: '2026-10-20' }))).toBe('overdue');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('date filters', () => {
  const tasks = [
    makeTask({ id: 'past', dueDate: '2026-10-19' }),
    makeTask({ id: 'pastDone', dueDate: '2026-10-19', status: 'done' }),
    makeTask({ id: 'today', dueDate: '2026-10-21', status: 'inProgress' }),
    makeTask({ id: 'todayDone', dueDate: '2026-10-21', status: 'done' }),
    makeTask({ id: 'tomorrow', dueDate: '2026-10-22' }),
    makeTask({ id: 'later', dueDate: '2026-12-01' }),
    makeTask({ id: 'laterDone', dueDate: '2026-12-01', status: 'done' }),
    makeTask({ id: 'none', dueDate: null }),
  ];
  const matching = (filter) => tasks.filter((task) => matchesDueFilter(task, filter, TODAY)).map((task) => task.id);

  it('overdue: before today and not completed', () => {
    expect(matching('overdue')).toEqual(['past']);
  });

  it('today: due on the current date, including tasks already completed today', () => {
    expect(matching('today')).toEqual(['today', 'todayDone']);
  });

  it('upcoming: after today (tomorrow included) and not completed', () => {
    expect(matching('upcoming')).toEqual(['tomorrow', 'later']);
  });

  it('tasks without a due date never match a date filter', () => {
    for (const filter of DUE_FILTERS) expect(matching(filter)).not.toContain('none');
    expect(matchesDueFilter(makeTask({ dueDate: null }), 'unknown', TODAY)).toBe(false);
  });

  it('several date filters combine with OR; other filters still apply with AND', () => {
    const shown = (overrides) => tasks.filter((task) => matchesView(task, view(overrides), TODAY)).map((task) => task.id);
    expect(shown({ due: ['overdue', 'today'] })).toEqual(['past', 'today', 'todayDone']);
    expect(shown({ due: ['today'], statuses: ['done'] })).toEqual(['todayDone']);
    expect(shown({ due: ['upcoming'], query: 'Task' }).length).toBe(2);
    expect(shown({ due: ['upcoming'], query: 'nothing like this' })).toEqual([]);
  });

  it('a date filter counts as filtering (and so disables drag-and-drop)', () => {
    expect(isFiltering(view({ due: ['today'] }))).toBe(true);
    expect(isDragAllowed(view({ due: ['today'] }))).toBe(false);
    expect(isFiltering(view())).toBe(false);
    // Older view objects without the field keep working.
    const { due, ...legacy } = EMPTY_VIEW;
    expect(due).toEqual([]);
    expect(isFiltering(legacy)).toBe(false);
    expect(matchesView(makeTask(), legacy, TODAY)).toBe(true);
  });

  it('Board and List views apply date filters with category scope and sorting', () => {
    const scoped = [
      makeTask({ id: 'w1', categoryId: 'work', dueDate: '2026-10-30', order: 0 }),
      makeTask({ id: 'w2', categoryId: 'work', dueDate: '2026-10-25', order: 1 }),
      makeTask({ id: 'w3', categoryId: 'work', dueDate: '2026-10-01', order: 2 }),
      makeTask({ id: 'h1', categoryId: 'home', dueDate: '2026-10-24', order: 3 }),
    ];
    const work = scopeTasks(scoped, 'work');
    const upcoming = view({ due: ['upcoming'] });
    expect(buildListView(work, upcoming, 'ru', TODAY).map((task) => task.id)).toEqual(['w1', 'w2']);
    expect(buildListView(work, { ...upcoming, sort: 'dueDate' }, 'ru', TODAY).map((task) => task.id)).toEqual(['w2', 'w1']);
    const board = buildBoardView(scopeTasks(scoped, ALL_TASKS), upcoming, 'ru', TODAY);
    expect(board.columns.todo.map((task) => task.id)).toEqual(['w1', 'w2', 'h1']);
    expect([board.shown, board.total]).toEqual([3, 4]);
  });

  it('status and due-date changes move tasks in and out of date filters at once', () => {
    let tasksState = [makeTask({ id: 'x', dueDate: '2026-10-10', status: 'todo', order: 0 })];
    const overdue = () => buildListView(tasksState, view({ due: ['overdue'] }), 'ru', TODAY).map((task) => task.id);
    expect(overdue()).toEqual(['x']);
    tasksState = tasksReducer(tasksState, { type: 'task/moved', id: 'x', status: 'done', index: 0 });
    expect(tasksState[0].status).toBe('done');
    expect(overdue()).toEqual([]);
    tasksState = tasksReducer(tasksState, { type: 'task/moved', id: 'x', status: 'todo', index: 0 });
    expect(overdue()).toEqual(['x']);
    tasksState = tasksReducer(tasksState, { type: 'task/updated', id: 'x', changes: { dueDate: '2026-10-21' } });
    expect(overdue()).toEqual([]);
    expect(buildListView(tasksState, view({ due: ['today'] }), 'ru', TODAY).map((task) => task.id)).toEqual(['x']);
    tasksState = tasksReducer(tasksState, { type: 'tasks/bulkUpdated', ids: ['x'], changes: { dueDate: null } });
    for (const filter of DUE_FILTERS) expect(buildListView(tasksState, view({ due: [filter] }), 'ru', TODAY)).toEqual([]);
  });

  it('statistics use the same overdue rule as the indicators', () => {
    const stats = computeStats(tasks, TODAY);
    expect(stats.overdue).toBe(tasks.filter((task) => dueState(task, TODAY) === 'overdue').length);
    expect(stats.overdue).toBe(1);
  });
});

describe('quick due dates', () => {
  it('today, tomorrow and in 7 days', () => {
    expect(keys(['today', 'tomorrow', 'in7Days'].map((kind) => quickDate(kind, TODAY, 1)))).toEqual(['2026-10-21', '2026-10-22', '2026-10-28']);
    expect(quickDate('unknown', TODAY, 1)).toBeNull();
    expect(QUICK_DATES).toEqual(['today', 'tomorrow', 'in7Days', 'nextWeek']);
  });

  it('"next week" is the first day of the next calendar week (Monday in Russian, Sunday in English)', () => {
    expect(toDateKey(quickDate('nextWeek', TODAY, 1))).toBe('2026-10-26'); // Monday
    expect(toDateKey(quickDate('nextWeek', TODAY, 0))).toBe('2026-10-25'); // Sunday
    // On the first day of a week, "next week" is a full week ahead, never today.
    expect(toDateKey(startOfNextWeek(new Date(2026, 9, 26), 1))).toBe('2026-11-02');
    expect(toDateKey(startOfNextWeek(new Date(2026, 9, 25), 0))).toBe('2026-11-01');
    // On the last day of a week, it is tomorrow.
    expect(toDateKey(startOfNextWeek(new Date(2026, 9, 25), 1))).toBe('2026-10-26');
    for (let day = 0; day < 14; day += 1) {
      const date = new Date(2026, 9, 18 + day);
      for (const weekStart of [0, 1]) {
        const next = startOfNextWeek(date, weekStart);
        expect(next.getDay()).toBe(weekStart);
        const ahead = Math.round((next - date) / 86400000);
        expect(ahead).toBeGreaterThanOrEqual(1);
        expect(ahead).toBeLessThanOrEqual(7);
      }
    }
  });

  it('crosses month and year ends', () => {
    const date = new Date(2026, 11, 28); // Monday 28 Dec 2026
    expect(keys([quickDate('tomorrow', date, 1), quickDate('in7Days', date, 1), quickDate('nextWeek', date, 1)])).toEqual([
      '2026-12-29',
      '2027-01-04',
      '2027-01-04',
    ]);
  });
});

describe('local calendar dates across time zones', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // 22:30 UTC on 21 Oct is already 22 Oct in Kiribati (UTC+14) and Moscow (UTC+3),
  // and still 21 Oct in Los Angeles (UTC-7).
  const instant = new Date(Date.UTC(2026, 9, 21, 22, 30));
  it.each([
    ['Pacific/Kiritimati', '2026-10-22'],
    ['Europe/Moscow', '2026-10-22'],
    ['America/Los_Angeles', '2026-10-21'],
    ['UTC', '2026-10-21'],
  ])('%s: "today" is the local date %s', (tz, localDate) => {
    process.env.TZ = tz;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(instant);
    expect(toDateKey(startOfToday())).toBe(localDate);
    expect(dueState(makeTask({ dueDate: localDate }))).toBe('today');
    expect(dueState(makeTask({ dueDate: toDateKey(new Date(2026, 9, Number(localDate.slice(8)) - 1)) }))).toBe('overdue');
    expect(matchesDueFilter(makeTask({ dueDate: localDate }), 'today')).toBe(true);
    expect(toDateKey(quickDate('tomorrow', startOfToday(), 1))).toBe(toDateKey(new Date(2026, 9, Number(localDate.slice(8)) + 1)));
  });

  it('one minute before and after local midnight', () => {
    process.env.TZ = 'Asia/Tokyo';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 21, 23, 59));
    expect(dueState(makeTask({ dueDate: '2026-10-21' }))).toBe('today');
    vi.setSystemTime(new Date(2026, 9, 22, 0, 1));
    expect(dueState(makeTask({ dueDate: '2026-10-21' }))).toBe('overdue');
    expect(dueState(makeTask({ dueDate: '2026-10-22' }))).toBe('today');
  });

  it('daylight-saving changes do not shift quick dates or states (Berlin)', () => {
    process.env.TZ = 'Europe/Berlin';
    // Clocks go forward on 29 Mar 2026 and back on 25 Oct 2026.
    for (const [day, tomorrow, week] of [
      [new Date(2026, 2, 28), '2026-03-29', '2026-04-04'],
      [new Date(2026, 9, 24), '2026-10-25', '2026-10-31'],
      [new Date(2026, 9, 25), '2026-10-26', '2026-11-01'],
    ]) {
      expect(toDateKey(quickDate('tomorrow', day, 1))).toBe(tomorrow);
      expect(toDateKey(quickDate('in7Days', day, 1))).toBe(week);
      expect(dueState(makeTask({ dueDate: tomorrow }), day)).toBe('tomorrow');
    }
    expect(toDateKey(quickDate('nextWeek', new Date(2026, 2, 25), 1))).toBe('2026-03-30');
  });
});

describe('useToday', () => {
  afterEach(() => vi.useRealTimers());

  it('moves to the next day at local midnight', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(2026, 9, 21, 23, 59, 0));
    const { result, unmount } = renderHook(() => useToday());
    expect(toDateKey(result.current)).toBe('2026-10-21');
    act(() => vi.advanceTimersByTime(30_000));
    expect(toDateKey(result.current)).toBe('2026-10-21');
    act(() => vi.advanceTimersByTime(32_000));
    expect(toDateKey(result.current)).toBe('2026-10-22');
    // And keeps going the following night.
    act(() => vi.advanceTimersByTime(24 * 60 * 60 * 1000));
    expect(toDateKey(result.current)).toBe('2026-10-23');
    unmount();
  });
});
