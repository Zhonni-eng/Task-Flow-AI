// @vitest-environment node
// Task context selection (electron/ai/taskContext.cjs): only the tasks a message is about.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { makeTask } from '../helpers/fixtures.js';

const require = createRequire(import.meta.url);
const { selectTaskContext, taskSummary, tagSummary, MAX_CONTEXT_TASKS, wordsMatch } = require('../../electron/ai/taskContext.cjs');
const { buildUserTurn } = require('../../electron/ai/prompt.cjs');

const tasks = [
  makeTask({ id: 'report', title: 'Подготовить отчёт для совета', status: 'todo', dueDate: '2026-10-25', description: 'секретные цифры', labels: ['финансы'] }),
  makeTask({ id: 'bank', title: 'Call the bank', status: 'inProgress' }),
  makeTask({ id: 'mom', title: 'Позвонить маме', status: 'todo' }),
  makeTask({ id: 'dad', title: 'Позвонить папе', status: 'done' }),
  makeTask({ id: 'secret', title: 'Секретный проект', description: 'не отправлять' }),
];
const ids = (message, pinned) => selectTaskContext(message, tasks, pinned).map((task) => task.id);

describe('matching', () => {
  it('matches Russian word forms and English plurals by stem', () => {
    expect(ids('Отчёт готов')).toEqual(['report']);
    expect(ids('отчета к пятнице нет')).toEqual(['report']);
    expect(ids('the banks call is done')).toEqual(['bank']);
    // Best match first; a partial match is still listed so the assistant can tell them apart or ask.
    expect(ids('позвони маме завтра')).toEqual(['mom', 'dad']);
  });

  it('lists every task that could match, so the assistant can ask which one', () => {
    expect(ids('Позвонить сделано').sort()).toEqual(['dad', 'mom']);
  });

  it('ignores command words and dates - they must not pull in unrelated tasks', () => {
    expect(ids('Сделай задачу готово завтра в пятницу')).toEqual([]);
    expect(ids('mark the task done tomorrow')).toEqual([]);
  });

  it('sends scheduling fields, tags and subtasks of named tasks - never descriptions', () => {
    const [entry] = selectTaskContext('отчёт', tasks);
    expect(Object.keys(entry).sort()).toEqual([
      'categoryId', 'completedAt', 'dueDate', 'dueTime', 'estimateMinutes', 'id', 'labels', 'planned', 'priority', 'recurrence', 'reminders', 'status', 'subtasks', 'title',
    ]);
    expect(entry).toMatchObject({ id: 'report', title: 'Подготовить отчёт для совета', status: 'todo', dueDate: '2026-10-25' });
    expect(JSON.stringify(entry)).not.toMatch(/секретные/);
    expect(entry.labels).toEqual(['финансы']);
  });

  it('wordsMatch needs a real stem, not just a shared start', () => {
    expect(wordsMatch('отчет', 'отчета')).toBe(true);
    expect(wordsMatch('мама', 'маме')).toBe(true);
    expect(wordsMatch('проект', 'прогулка')).toBe(false);
    expect(wordsMatch('кот', 'котлета')).toBe(false);
  });
});

describe('follow-ups and limits', () => {
  it('pinned tasks of this session come first even without matching words', () => {
    expect(ids('перенеси её на пятницу', ['bank'])).toEqual(['bank']);
    expect(ids('отчёт', ['bank'])).toEqual(['bank', 'report']);
  });

  it('pinned ids that no longer exist are ignored', () => {
    expect(ids('её', ['deleted-task'])).toEqual([]);
  });

  it(`never sends more than ${MAX_CONTEXT_TASKS} tasks`, () => {
    const many = Array.from({ length: 60 }, (_, i) => makeTask({ id: `m${i}`, title: `Молоко ${i}` }));
    expect(selectTaskContext('молоко', many)).toHaveLength(MAX_CONTEXT_TASKS);
  });

  it('copes with bad input', () => {
    expect(selectTaskContext('отчёт', null)).toEqual([]);
    expect(selectTaskContext(42, tasks)).toEqual([]);
    expect(selectTaskContext('отчёт', [null, { id: 1 }, ...tasks]).map((task) => task.id)).toEqual(['report']);
  });
});

describe('group requests (questions, day plans)', () => {
  const board = [
    makeTask({ id: 'late', title: 'Сдать эссе', dueDate: '2026-10-20' }),
    makeTask({ id: 'now', title: 'Позвонить врачу', dueDate: '2026-10-25', dueTime: '09:00' }),
    makeTask({ id: 'later', title: 'Купить подарок', dueDate: '2026-10-25', dueTime: '18:00' }),
    makeTask({ id: 'week', title: 'Отчёт', dueDate: '2026-10-29', priority: 'high' }),
    makeTask({ id: 'study', title: 'Конспект', categoryId: 'cat-study' }),
    makeTask({ id: 'old', title: 'Старое', status: 'done', completedAt: '2026-09-01T00:00:00.000Z' }),
  ];
  const options = { todayKey: '2026-10-25', nowTime: '12:00', categories: [{ id: 'cat-study', name: 'Учёба' }] };
  const pick = (message) => selectTaskContext(message, board, [], options).map((task) => task.id);

  it('overdue questions get overdue tasks (a due time that passed today counts)', () => {
    expect(pick('Что у меня просрочено?').sort()).toEqual(['late', 'now']);
  });

  it('a mentioned category brings its tasks', () => {
    expect(pick('Что осталось по учёбе?')).toEqual(['study']);
  });

  it('a day plan gets overdue, today, the coming week and high-priority tasks', () => {
    expect(pick('Составь план на день').sort()).toEqual(['late', 'later', 'now', 'week']);
  });

  it('Russian case endings that differ by two letters still match ("лабораторной" / "Лабораторная")', () => {
    expect(wordsMatch('лабораторной', 'лабораторная')).toBe(true);
  });

  it('completed tasks only when asked about them as a group, not for "X is done"', () => {
    expect(pick('Покажи выполненные задачи')).toEqual(['old']);
    expect(pick('Отчёт готов')).toEqual(['week']);
  });

  it('the summary counts every task without sending them', () => {
    expect(taskSummary(board, '2026-10-25', '12:00')).toEqual({ total: 6, todo: 5, inProgress: 0, done: 1, overdue: 2, dueToday: 2 });
  });
});

describe('tags', () => {
  const tagged = [
    makeTask({ id: 'a', title: 'Купить хлеб', labels: ['Покупки', 'срочно'] }),
    makeTask({ id: 'b', title: 'Позвонить маме', labels: ['покупки'] }),
    makeTask({ id: 'c', title: 'Отчёт', labels: [] }),
  ];

  it('tagSummary lists every tag once (case-insensitive) with its task count, most used first', () => {
    expect(tagSummary(tagged)).toEqual([{ name: 'Покупки', count: 2 }, { name: 'срочно', count: 1 }]);
    expect(tagSummary(null)).toEqual([]);
  });

  it('a message naming a tag brings in the tasks that carry it', () => {
    expect(selectTaskContext('убери метку покупки у всех задач', tagged).map((task) => task.id).sort()).toEqual(['a', 'b']);
    expect(selectTaskContext('rename the tag срочно', tagged).map((task) => task.id)).toEqual(['a']);
  });

  it('the app context lists the existing tags and the tags of each task', () => {
    const content = buildUserTurn({
      message: 'x', language: 'ru', categories: [], tasks: selectTaskContext('покупки', tagged), tags: tagSummary(tagged),
      date: { today: '2026-10-25', weekday: 'Sunday', time: '12:00', timeZone: 'UTC' },
    });
    expect(content).toContain('- Tags (tasks with it):\n- "Покупки" (2)\n- "срочно" (1)');
    expect(content).toContain('tags: "Покупки", "срочно"');
  });
});
