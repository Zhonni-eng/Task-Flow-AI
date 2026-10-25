// Local reminders (main process). Reminder times are computed from the saved tasks
// (electron/shared/schedule.mjs) - never kept as in-memory timers only - and every reminder that
// was shown or deliberately skipped is recorded in its own file, so a restart or a reboot neither
// repeats nor loses one:
//
//   taskflow-reminders.json = { version: 1, fired: { '<reminder key>': '<ISO time handled>' } }
//
// A reminder key contains the task id, its deadline and the offset, so changing the deadline
// creates new reminders and the old ones are simply never due again (no stale timers to cancel).
// Deleted or completed tasks have no reminders.
//
// Timing: one timer to the next reminder, but never longer than CHECK_INTERVAL_MS, so a clock or
// time-zone change, DST and missed timers (Windows sleep) are noticed within a minute; Windows
// "resume" / "unlock" trigger a check at once, and so does every save.
//
// Missed reminders (app closed, computer asleep): reminders whose time passed less than
// MISSED_WINDOW_MS ago are shown once, together, as "missed reminders"; older ones are recorded as
// handled without a notification. Reminders cannot fire while Taskflow is not running.
const fs = require('node:fs');
const path = require('node:path');
const { reminderSchedule } = require('./shared/schedule.mjs');

const FILE_NAME = 'taskflow-reminders.json';
const VERSION = 1;
const CHECK_INTERVAL_MS = 60_000;
const ON_TIME_GRACE_MS = 5 * 60_000; // up to 5 minutes late still counts as on time
const MISSED_WINDOW_MS = 24 * 60 * 60_000;
const KEEP_RECORDS_MS = 60 * 24 * 60 * 60_000;
const MAX_RECORDS = 5000;
const SAVE_DEBOUNCE_MS = 300;

const TEXT = {
  ru: {
    title: (task) => `Напоминание: ${task}`,
    due: (when) => `Срок: ${when}`,
    missedTitle: (count) => `Пропущенные напоминания: ${count}`,
    more: (count) => `и ещё ${count}`,
  },
  en: {
    title: (task) => `Reminder: ${task}`,
    due: (when) => `Due: ${when}`,
    missedTitle: (count) => `Missed reminders: ${count}`,
    more: (count) => `and ${count} more`,
  },
};

const reminderKey = (task, offset, allDayTime) => [task.id, task.dueDate, task.dueTime ?? `day@${allDayTime}`, offset].join('|');

/** "30 Oct, 16:30" / "30 окт., 16:30" or the date alone, in local time. */
function formatDeadline(task, language) {
  const locale = language === 'en' ? 'en-GB' : 'ru-RU';
  const [year, month, day] = task.dueDate.split('-').map(Number);
  const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(year, month - 1, day));
  return task.dueTime ? `${date}, ${task.dueTime}` : date;
}

/**
 * `getData()` -> { tasks, settings } from storage (main process); `notify({ title, body })` shows a
 * desktop notification. `now`, timers and the folder are injectable for tests.
 */
function createReminderScheduler({
  dir,
  getData,
  notify,
  now = () => new Date(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  log = () => {},
}) {
  const file = path.join(dir, FILE_NAME);
  let fired = load();
  let timer = null;
  let debounce = null;
  let stopped = false;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && raw.version === VERSION && raw.fired && typeof raw.fired === 'object' && !Array.isArray(raw.fired)) {
        return Object.fromEntries(Object.entries(raw.fired).filter(([key, value]) => typeof key === 'string' && typeof value === 'string'));
      }
    } catch {
      // Missing or unreadable: start empty. Worst case a recent reminder is shown again once.
    }
    return {};
  }

  function persist() {
    const temp = `${file}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(temp, JSON.stringify({ version: VERSION, fired }, null, 2));
      fs.renameSync(temp, file);
    } catch {
      // Not fatal: reminders still work; at worst one may be shown again after a restart.
      log('reminder state could not be saved');
    }
  }

  /** Every reminder of every open task: [{ key, at, task }]. */
  function collect(tasks, allDayTime) {
    const list = [];
    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (!task || task.status === 'done') continue;
      for (const { offset, at } of reminderSchedule(task, allDayTime)) {
        if (!Number.isNaN(at.getTime())) list.push({ key: reminderKey(task, offset, allDayTime), at, task });
      }
    }
    return list;
  }

  /** Shows what is due, records it, and returns the next reminder time (or null). */
  function check() {
    if (stopped) return null;
    let data;
    try {
      data = getData();
    } catch {
      data = null;
    }
    // Not loaded yet (the window loads the data at startup): do nothing - in particular do not
    // treat "no tasks" as "all tasks deleted" and drop the records of what was already shown.
    if (!data || !Array.isArray(data.tasks)) return null;
    const { tasks } = data;
    const settings = data?.settings?.reminders ?? { enabled: true, allDayTime: '09:00' };
    const language = data?.settings?.language === 'en' ? 'en' : 'ru';
    const current = now();
    const all = collect(tasks, settings.allDayTime);
    let changed = false;
    const onTime = [];
    const missed = [];
    let next = null;

    for (const item of all) {
      if (fired[item.key]) continue;
      const late = current.getTime() - item.at.getTime();
      if (late < 0) {
        if (!next || item.at < next) next = item.at;
        continue;
      }
      // Due now: recorded either way. With reminders switched off nothing is shown, and switching
      // them back on later does not bring these back as "missed".
      fired[item.key] = current.toISOString();
      changed = true;
      if (!settings.enabled) continue;
      if (late <= ON_TIME_GRACE_MS) onTime.push(item);
      else if (late <= MISSED_WINDOW_MS) missed.push(item);
    }

    for (const item of onTime) {
      notify({ title: TEXT[language].title(item.task.title), body: TEXT[language].due(formatDeadline(item.task, language)), taskId: item.task.id });
    }
    if (missed.length > 0) {
      const names = missed.slice(0, 3).map((item) => `• ${item.task.title} (${formatDeadline(item.task, language)})`);
      if (missed.length > 3) names.push(TEXT[language].more(missed.length - 3));
      notify({ title: TEXT[language].missedTitle(missed.length), body: names.join('\n'), taskId: null });
    }

    // Forget records of deleted tasks and old reminders, so the file stays small.
    const liveTasks = new Set((Array.isArray(tasks) ? tasks : []).map((task) => task?.id));
    const keys = Object.keys(fired);
    for (const key of keys) {
      const handledAt = Date.parse(fired[key]);
      if (!liveTasks.has(key.split('|')[0]) || !(current.getTime() - handledAt < KEEP_RECORDS_MS)) {
        delete fired[key];
        changed = true;
      }
    }
    if (Object.keys(fired).length > MAX_RECORDS) {
      fired = Object.fromEntries(Object.entries(fired).sort((a, b) => b[1].localeCompare(a[1])).slice(0, MAX_RECORDS));
      changed = true;
    }
    if (changed) persist();
    return next;
  }

  function schedule() {
    if (stopped) return;
    if (timer) clearTimer(timer);
    const next = check();
    const wait = next ? Math.min(Math.max(next.getTime() - now().getTime(), 1000), CHECK_INTERVAL_MS) : CHECK_INTERVAL_MS;
    timer = setTimer(schedule, wait);
  }

  /** After a save (tasks or settings changed): re-check soon, once. */
  function refresh() {
    if (stopped) return;
    if (debounce) clearTimer(debounce);
    debounce = setTimer(() => {
      debounce = null;
      schedule();
    }, SAVE_DEBOUNCE_MS);
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    if (debounce) clearTimer(debounce);
  }

  return { start: schedule, refresh, check, stop, file, records: () => ({ ...fired }) };
}

module.exports = { createReminderScheduler, FILE_NAME, CHECK_INTERVAL_MS, ON_TIME_GRACE_MS, MISSED_WINDOW_MS, reminderKey };
