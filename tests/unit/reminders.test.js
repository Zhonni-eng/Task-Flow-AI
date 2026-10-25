// @vitest-environment node
// Reminder scheduler (electron/reminders.cjs) with an injected clock, timers and a temp folder:
// on-time reminders, no duplicates across restarts, rescheduling, deleted/completed tasks, missed
// reminders after the app was closed, switched-off reminders, and the timer cap.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTask } from '../helpers/fixtures.js';
import { createTempDir } from '../helpers/tempDir.js';

const require = createRequire(import.meta.url);
const { createReminderScheduler, CHECK_INTERVAL_MS, FILE_NAME } = require('../../electron/reminders.cjs');

let temp;
let clock;
let data;
let shown;
let timers;
beforeEach(() => {
  temp = createTempDir();
  clock = new Date(2026, 9, 30, 15, 0); // 30 Oct 2026 15:00 local
  data = { tasks: [], settings: { language: 'ru', reminders: { enabled: true, allDayTime: '09:00' } } };
  shown = [];
  timers = [];
});
afterEach(() => temp.remove());

const scheduler = () =>
  createReminderScheduler({
    dir: temp.dir,
    getData: () => data,
    notify: (note) => shown.push(note),
    now: () => clock,
    setTimer: (fn, ms) => {
      timers.push(ms);
      return timers.length;
    },
    clearTimer: () => {},
  });
const at = (hours, minutes = 0, day = 30) => new Date(2026, 9, day, hours, minutes);
const exam = (overrides = {}) => makeTask({ id: 'exam', title: 'Экзамен', dueDate: '2026-10-30', dueTime: '16:30', reminders: [30], ...overrides });

describe('reminders', () => {
  it('fires once at its time, with the task and its deadline', () => {
    data.tasks = [exam()];
    const reminders = scheduler();
    reminders.check();
    expect(shown).toEqual([]);
    clock = at(16, 0);
    reminders.check();
    expect(shown).toEqual([{ title: 'Напоминание: Экзамен', body: 'Срок: 30 окт., 16:30', taskId: 'exam' }]);
    reminders.check();
    expect(shown).toHaveLength(1);
  });

  it('is not shown again after a restart (recorded on disk)', () => {
    data.tasks = [exam()];
    clock = at(16, 1);
    scheduler().check();
    expect(shown).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(temp.file(FILE_NAME), 'utf8')).fired).toHaveProperty(['exam|2026-10-30|16:30|30']);
    scheduler().check();
    expect(shown).toHaveLength(1);
  });

  it('changing the deadline reschedules: the old reminder never fires, the new one does', () => {
    data.tasks = [exam()];
    const reminders = scheduler();
    reminders.check();
    data.tasks = [exam({ dueTime: '18:00' })];
    clock = at(16, 0);
    reminders.check();
    expect(shown).toEqual([]);
    clock = at(17, 30);
    reminders.check();
    expect(shown.map((note) => note.body)).toEqual(['Срок: 30 окт., 18:00']);
  });

  it('deleted and completed tasks have no reminders; their records are dropped', () => {
    data.tasks = [exam(), exam({ id: 'done', status: 'done' })];
    clock = at(16, 0);
    const reminders = scheduler();
    reminders.check();
    expect(shown.map((note) => note.taskId)).toEqual(['exam']);
    data.tasks = [];
    reminders.check();
    expect(reminders.records()).toEqual({});
  });

  it('missed while closed: recent ones are shown once, together; older ones are skipped silently', () => {
    data.tasks = [
      exam({ id: 'a', title: 'A', dueTime: '12:00', reminders: [0] }), // 3 h ago
      exam({ id: 'b', title: 'B', dueDate: '2026-10-28', dueTime: '12:00', reminders: [0] }), // 2 days ago
    ];
    scheduler().check();
    expect(shown).toEqual([{ title: 'Пропущенные напоминания: 1', body: '• A (30 окт., 12:00)', taskId: null }]);
    expect(Object.keys(scheduler().records()).sort()).toEqual(['a|2026-10-30|12:00|0', 'b|2026-10-28|12:00|0']);
  });

  it('a task without a due time reminds at the "time for tasks without a time" setting', () => {
    data.tasks = [makeTask({ id: 'rent', title: 'Аренда', dueDate: '2026-10-31', reminders: [1440] })];
    data.settings.reminders.allDayTime = '15:30';
    const reminders = scheduler();
    reminders.check();
    expect(shown).toEqual([]);
    clock = at(15, 30);
    reminders.check();
    expect(shown.map((note) => note.body)).toEqual(['Срок: 31 окт.']);
  });

  it('switched off: nothing is shown, and switching on later does not bring them back as missed', () => {
    data.tasks = [exam()];
    data.settings.reminders.enabled = false;
    clock = at(16, 0);
    const reminders = scheduler();
    reminders.check();
    data.settings.reminders.enabled = true;
    clock = at(16, 10);
    reminders.check();
    expect(shown).toEqual([]);
  });

  it('English text', () => {
    data.tasks = [exam()];
    data.settings.language = 'en';
    clock = at(16, 0);
    scheduler().check();
    expect(shown[0]).toMatchObject({ title: 'Reminder: Экзамен', body: 'Due: 30 Oct, 16:30' });
  });

  it('waits until the next reminder, but never longer than a minute (clock changes, sleep)', () => {
    data.tasks = [exam()];
    clock = at(16, 0, 29); // a day before: the next reminder is far away
    const reminders = scheduler();
    reminders.start();
    expect(timers.at(-1)).toBe(CHECK_INTERVAL_MS);
    clock = new Date(at(16, 0).getTime() - 20_000); // 20 s before
    reminders.start();
    expect(timers.at(-1)).toBe(20_000);
  });

  it('no data loaded yet (window not ready): nothing happens, and earlier records are kept', () => {
    data.tasks = [exam()];
    clock = at(16, 0);
    scheduler().check();
    expect(shown).toHaveLength(1);
    // Restart: the scheduler runs before the window has loaded the data...
    const loaded = data;
    data = null;
    const restarted = scheduler();
    expect(() => restarted.check()).not.toThrow();
    // ...and once the data is there, the reminder that was already shown is not shown again.
    data = loaded;
    restarted.check();
    expect(shown).toHaveLength(1);
    expect(Object.keys(restarted.records())).toEqual(['exam|2026-10-30|16:30|30']);
  });
});
