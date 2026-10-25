// @vitest-environment node
// Deadlines, reminder schedules and recurrence (electron/shared/schedule.mjs), plus the reducer's
// completion behaviour. Time-zone dependent cases run in Europe/Berlin (DST on 29 Mar and 25 Oct
// 2026) by setting TZ for this file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deadlineInstant,
  localDateKey,
  localInstant,
  nextDueDateAfterCompletion,
  nextOccurrence,
  normalizeDueTime,
  normalizeRecurrence,
  normalizeReminders,
  reminderSchedule,
} from '../../electron/shared/schedule.mjs';
import { createTask } from '../../src/data/taskModel.js';
import { taskActions, tasksReducer, withStatus } from '../../src/state/tasksReducer.js';

const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Europe/Berlin';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const iso = (date) => date.toISOString();

describe('due times and reminders', () => {
  it('a due time needs a due date; invalid times are dropped', () => {
    expect(normalizeDueTime('16:30', '2026-10-30')).toBe('16:30');
    expect(normalizeDueTime('16:30', null)).toBeNull();
    expect(normalizeDueTime('24:00', '2026-10-30')).toBeNull();
    expect(normalizeDueTime('9:5', '2026-10-30')).toBeNull();
  });

  it('reminders: minute offsets need a due time; whole days work without one; unique, sorted, at most 5', () => {
    expect(normalizeReminders([60, 10, 10, 1440], '2026-10-30', '16:30')).toEqual([10, 60, 1440]);
    expect(normalizeReminders([60, 10, 1440, 2880], '2026-10-30', null)).toEqual([1440, 2880]);
    expect(normalizeReminders([10], null, null)).toEqual([]);
    expect(normalizeReminders([0, 10, 30, 60, 120, 1440], '2026-10-30', '16:30')).toHaveLength(5);
    expect(normalizeReminders([-5, 1.5, '10', 50_000], '2026-10-30', '16:30')).toEqual([]);
  });

  it('timed reminders count back on the wall clock - also across a DST change', () => {
    // 25 Oct 2026: clocks go back. A 1-day reminder for 26 Oct 09:00 fires 25 Oct 09:00 local.
    const task = { dueDate: '2026-10-26', dueTime: '09:00', reminders: [30, 1440] };
    const schedule = reminderSchedule(task);
    expect(schedule.map((item) => [item.offset, localDateKey(item.at), item.at.getHours(), item.at.getMinutes()])).toEqual([
      [30, '2026-10-26', 8, 30],
      [1440, '2026-10-25', 9, 0],
    ]);
  });

  it('date-only reminders fire at the "reminder time for tasks without a time" setting', () => {
    const [item] = reminderSchedule({ dueDate: '2026-10-30', dueTime: null, reminders: [1440] }, '08:15');
    expect(localDateKey(item.at)).toBe('2026-10-29');
    expect([item.at.getHours(), item.at.getMinutes()]).toEqual([8, 15]);
  });

  it('a time that does not exist (spring forward) becomes the next valid time', () => {
    const at = localInstant('2026-03-29', '02:30');
    expect([at.getHours(), at.getMinutes()]).toEqual([3, 30]);
  });

  it('deadline: the due time, or the end of the due day without one', () => {
    expect(iso(deadlineInstant({ dueDate: '2026-10-30', dueTime: '16:30' }))).toBe(iso(new Date(2026, 9, 30, 16, 30)));
    expect(iso(deadlineInstant({ dueDate: '2026-10-30', dueTime: null }))).toBe(iso(new Date(2026, 9, 31, 0, 0)));
    expect(deadlineInstant({ dueDate: null })).toBeNull();
  });
});

describe('recurrence', () => {
  it('rules are normalized against the due date; no due date means no rule', () => {
    expect(normalizeRecurrence({ freq: 'weekly' }, '2026-10-30')).toEqual({ freq: 'weekly', interval: 1, weekdays: [5] });
    expect(normalizeRecurrence({ freq: 'monthly', interval: 2 }, '2026-01-31')).toEqual({ freq: 'monthly', interval: 2, monthDay: 31 });
    expect(normalizeRecurrence({ freq: 'daily', interval: 500 }, '2026-10-30')).toEqual({ freq: 'daily', interval: 1 });
    expect(normalizeRecurrence({ freq: 'hourly' }, '2026-10-30')).toBeNull();
    expect(normalizeRecurrence({ freq: 'daily' }, null)).toBeNull();
  });

  it.each([
    ['daily', { freq: 'daily', interval: 1 }, '2026-10-30', '2026-10-30', '2026-10-31'],
    ['every 3 days', { freq: 'daily', interval: 3 }, '2026-10-30', '2026-11-04', '2026-11-05'],
    ['weekly on Mon/Thu', { freq: 'weekly', interval: 1, weekdays: [1, 4] }, '2026-10-26', '2026-10-26', '2026-10-29'],
    ['every 2 weeks on Friday', { freq: 'weekly', interval: 2, weekdays: [5] }, '2026-10-30', '2026-10-30', '2026-11-13'],
    ['monthly on the 31st (short months use their last day)', { freq: 'monthly', interval: 1, monthDay: 31 }, '2026-01-31', '2026-01-31', '2026-02-28'],
    ['monthly on the 1st', { freq: 'monthly', interval: 1, monthDay: 1 }, '2026-11-01', '2026-11-01', '2026-12-01'],
  ])('%s', (_, rule, from, after, expected) => {
    expect(nextOccurrence(rule, from, after)).toBe(expected);
  });

  it('completing: missed occurrences are skipped; early completion moves to the following one', () => {
    const daily = { freq: 'daily', interval: 1 };
    expect(nextDueDateAfterCompletion(daily, '2026-10-20', '2026-10-25')).toBe('2026-10-26');
    const monthly = { freq: 'monthly', interval: 1, monthDay: 1 };
    expect(nextDueDateAfterCompletion(monthly, '2026-11-01', '2026-10-25')).toBe('2026-12-01');
  });
});

describe('completing tasks (reducer)', () => {
  const now = new Date(2026, 9, 25, 10, 0);

  it('completing records completedAt; reopening clears it', () => {
    const done = withStatus(createTask({ title: 'A' }), 'done', now);
    expect(done).toMatchObject({ status: 'done', completedAt: now.toISOString() });
    expect(withStatus(done, 'todo', now)).toMatchObject({ status: 'todo', completedAt: null });
  });

  it('completing a recurring task moves it to its next occurrence in To Do with its checklist unticked', () => {
    const task = createTask({
      title: 'Оплатить аренду',
      dueDate: '2026-11-01',
      recurrence: { freq: 'monthly', monthDay: 1 },
      subtasks: [{ id: 's1', title: 'Перевод', done: true }],
      status: 'inProgress',
    });
    let state = tasksReducer([], { type: 'task/created', task });
    state = tasksReducer(state, taskActions.move(task.id, 'done', 0));
    expect(state[0]).toMatchObject({ status: 'todo', dueDate: '2026-12-01', recurrence: { freq: 'monthly', interval: 1, monthDay: 1 } });
    expect(state[0].subtasks[0].done).toBe(false);
    expect(typeof state[0].completedAt).toBe('string');
  });

  it('replace: swaps whole tasks by id, inserts missing ones, removes others and renumbers', () => {
    const a = createTask({ id: 'a', title: 'A' });
    const b = createTask({ id: 'b', title: 'B' });
    let state = [a, b].reduce((list, task) => tasksReducer(list, { type: 'task/created', task }), []);
    state = tasksReducer(state, taskActions.replace([{ ...a, title: 'A2' }, createTask({ id: 'c', title: 'C' })], ['b']));
    expect(state.map((task) => [task.id, task.title]).sort()).toEqual([['a', 'A2'], ['c', 'C']]);
    expect(state.map((task) => task.order).sort()).toEqual([0, 1]);
  });
});
