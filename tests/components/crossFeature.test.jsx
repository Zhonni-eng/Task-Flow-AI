// Stage 5 cross-feature regressions: Stages 1–4 working together through the real UI and the
// real storage module (temp folders, controlled clock: Wednesday 21 Oct 2026).
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXED_TODAY, makeCategory, makeDocument, makeTask } from '../helpers/fixtures.js';
import { allCardTitles, card, cardTitles, listRows, navButton, statsText, toastMessages } from '../helpers/queries.js';
import { createBridge, renderApp } from '../helpers/renderApp.jsx';

let env;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_TODAY);
});
afterEach(() => {
  vi.useRealTimers();
  env?.temp.remove();
});

const subtasks = (prefix) => [
  { id: `${prefix}-1`, title: 'Первый шаг', done: true },
  { id: `${prefix}-2`, title: 'Второй шаг', done: false },
];
const seeded = () =>
  makeDocument({
    categories: [makeCategory({ id: 'work', name: 'Работа', order: 0 }), makeCategory({ id: 'home', name: 'Дом', order: 1 })],
    tasks: [
      makeTask({ id: 'a', title: 'Альфа', order: 0, categoryId: 'work', dueDate: '2026-10-18', priority: 'high', labels: ['x'], subtasks: subtasks('a') }),
      makeTask({ id: 'b', title: 'Бета', order: 1, categoryId: 'home', dueDate: '2026-10-25', subtasks: subtasks('b') }),
      makeTask({ id: 'c', title: 'Гамма', order: 2, dueDate: '2026-10-21' }),
      makeTask({ id: 'd', title: 'Дельта', status: 'inProgress', order: 0, categoryId: 'work' }),
      makeTask({ id: 'e', title: 'Эпсилон', status: 'done', order: 0, dueDate: '2026-10-01', subtasks: subtasks('e') }),
    ],
  });
const start = async (document = seeded()) => {
  env = await renderApp({ document });
  return env;
};
const saved = (id) => env.readData().tasks.find((task) => task.id === id);
const toList = () => env.user.click(screen.getByRole('button', { name: 'Список' }));
const toBoard = () => env.user.click(screen.getByRole('button', { name: 'Доска' }));
const toolbar = () => screen.getByRole('toolbar', { name: 'Действия с выбранными задачами' });
const select = async (...titles) => {
  for (const title of titles) await env.user.click(screen.getByRole('checkbox', { name: `Выбрать задачу «${title}»` }));
};
const toggleDue = async (name) => {
  await env.user.click(screen.getByRole('button', { name: /^Фильтры/ }));
  await env.user.click(screen.getByRole('checkbox', { name }));
  await env.user.keyboard('{Escape}');
};
const search = (text) => env.user.type(screen.getByRole('searchbox', { name: 'Поиск по названию и описанию' }), text);
const editDue = async (title, quickName) => {
  await env.user.click(screen.getByRole('button', { name: title }));
  const dialog = screen.getByRole('dialog', { name: 'Редактирование задачи' });
  await env.user.click(within(dialog).getByRole('button', { name: /Срок/ }));
  if (quickName === null) await env.user.click(screen.getByRole('button', { name: 'Без срока' }));
  else await env.user.click(screen.getByRole('button', { name: new RegExp(`^${quickName}:`) }));
  await env.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
};
const subtaskChip = (title) => within(card(title)).queryByRole('img', { name: /^Подзадачи:/ });

describe('bulk actions on tasks with subtasks and due dates', () => {
  it('bulk status, priority, category and due date keep subtasks, ids and other fields', async () => {
    await start();
    await waitFor(() => expect(env.readData().tasks).toHaveLength(5));
    const before = Object.fromEntries(env.readData().tasks.map((task) => [task.id, task]));
    await toList();
    await select('Альфа', 'Бета');
    await env.user.selectOptions(within(toolbar()).getByRole('combobox', { name: 'Изменить приоритет выбранных задач' }), 'Низкий');
    await select('Альфа', 'Бета');
    await env.user.selectOptions(within(toolbar()).getByRole('combobox', { name: 'Изменить категорию выбранных задач' }), 'Дом');
    await select('Альфа', 'Бета');
    await env.user.click(within(toolbar()).getByRole('button', { name: /Срок/ }));
    await env.user.click(screen.getByRole('button', { name: /^Через 7 дней:/ }));
    await select('Альфа', 'Бета');
    await env.user.click(within(toolbar()).getByRole('button', { name: 'Выполнено' }));
    await waitFor(() => expect([saved('a').status, saved('b').status]).toEqual(['done', 'done']));
    for (const id of ['a', 'b']) {
      expect(saved(id)).toMatchObject({ id, priority: 'low', categoryId: 'home', dueDate: '2026-10-28', subtasks: before[id].subtasks, labels: before[id].labels, title: before[id].title });
    }
    // Untouched tasks keep every field; only their column position is renumbered (To Do lost two tasks).
    const withoutOrder = ({ order, ...rest }) => rest;
    for (const id of ['c', 'd', 'e']) expect(withoutOrder(saved(id))).toEqual(withoutOrder(before[id]));
    expect(saved('c').order).toBe(0);
  });

  it('bulk-completing an overdue parent removes the overdue state; reopening restores it', async () => {
    await start();
    await toList();
    expect(statsText()).toMatch(/1\s*Просрочено/);
    await select('Альфа');
    await env.user.click(within(toolbar()).getByRole('button', { name: 'Выполнено' }));
    expect(statsText()).toMatch(/0\s*Просрочено/);
    await env.user.selectOptions(screen.getByRole('combobox', { name: 'Статус задачи «Альфа»' }), 'К выполнению');
    expect(statsText()).toMatch(/1\s*Просрочено/);
    await toBoard();
    expect(card('Альфа').querySelector('.due')).toHaveAttribute('data-due-state', 'overdue');
    expect(subtaskChip('Альфа')).toHaveAccessibleName('Подзадачи: выполнено 1 из 2');
  });
});

describe('deleting parent tasks', () => {
  it('individual and bulk deletion remove subtasks with their parents and nothing else', async () => {
    await start();
    await waitFor(() => expect(env.readData().tasks).toHaveLength(5));
    await env.user.click(screen.getByRole('button', { name: 'Удалить задачу «Альфа»' }));
    await env.user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить' }));
    await toList();
    await select('Бета', 'Эпсилон');
    await env.user.click(within(toolbar()).getByRole('button', { name: 'Удалить' }));
    await env.user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /^Удалить/ }));
    await waitFor(() => expect(env.readData().tasks.map((task) => task.id).sort()).toEqual(['c', 'd']));
    const text = JSON.stringify(env.readData());
    for (const id of ['a-1', 'a-2', 'b-1', 'b-2', 'e-1', 'e-2']) expect(text).not.toContain(id);
  });
});

describe('date filters with search and edits', () => {
  it('editing a due date while a date filter and search are active updates the view and keeps the edit', async () => {
    await start();
    await toList();
    await toggleDue('Просроченные');
    await search('а');
    expect(listRows().map((row) => row.title)).toEqual(['Альфа']);
    await editDue('Альфа', 'Завтра');
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
    await waitFor(() => expect(saved('a').dueDate).toBe('2026-10-22'));
    expect(saved('a').subtasks).toEqual(subtasks('a'));
    await toggleDue('Просроченные');
    await toggleDue('Предстоящие');
    expect(listRows().map((row) => row.title)).toEqual(['Альфа', 'Бета']);
  });

  it('switching Board ↔ List keeps search, filters and sort, with the same tasks shown', async () => {
    await start();
    await toggleDue('Предстоящие');
    await toggleDue('На сегодня');
    expect(allCardTitles().sort()).toEqual(['Бета', 'Гамма']);
    await toList();
    expect(listRows().map((row) => row.title).sort()).toEqual(['Бета', 'Гамма']);
    await env.user.selectOptions(screen.getByRole('combobox', { name: /Сортировка/ }), 'По сроку');
    expect(listRows().map((row) => row.title)).toEqual(['Гамма', 'Бета']);
    await toBoard();
    expect(cardTitles('К выполнению')).toEqual(['Гамма', 'Бета']);
    expect(screen.getByRole('button', { name: 'Убрать «Предстоящие»' })).toBeInTheDocument();
  });
});

describe('sorting, moving and stable data', () => {
  it('status changes under a sort keep ids, subtasks and manual order consistent', async () => {
    await start();
    await waitFor(() => expect(env.readData().tasks).toHaveLength(5));
    const ids = env.readData().tasks.map((task) => task.id).sort();
    await toList();
    await env.user.selectOptions(screen.getByRole('combobox', { name: /Сортировка/ }), 'По приоритету');
    await env.user.selectOptions(screen.getByRole('combobox', { name: 'Статус задачи «Бета»' }), 'В работе');
    await env.user.selectOptions(screen.getByRole('combobox', { name: 'Статус задачи «Эпсилон»' }), 'К выполнению');
    await waitFor(() => expect(saved('b').status).toBe('inProgress'));
    const data = env.readData().tasks;
    expect(data.map((task) => task.id).sort()).toEqual(ids);
    expect(saved('b').subtasks).toEqual(subtasks('b'));
    expect(saved('e').subtasks).toEqual(subtasks('e'));
    // Every column keeps a dense 0..n-1 manual order.
    for (const status of ['todo', 'inProgress', 'done']) {
      const orders = data.filter((task) => task.status === status).map((task) => task.order).sort((x, y) => x - y);
      expect(orders).toEqual(orders.map((_, index) => index));
    }
  });
});

describe('categories in use', () => {
  it('deleting a category while viewing it with a selection reassigns its tasks and keeps their data', async () => {
    await start();
    await env.user.click(navButton('Работа'));
    await toList();
    await select('Альфа');
    await env.user.click(screen.getAllByRole('button', { name: 'Удалить категорию «Работа»' })[0]);
    const dialog = screen.getByRole('alertdialog', { name: 'Удалить категорию «Работа»?' });
    await env.user.click(within(dialog).getByRole('radio', { name: /Дом/ }));
    await env.user.click(within(dialog).getByRole('button', { name: 'Удалить категорию' }));
    expect(screen.queryByRole('toolbar', { name: 'Действия с выбранными задачами' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Все задачи');
    await waitFor(() => expect([saved('a').categoryId, saved('d').categoryId]).toEqual(['home', 'home']));
    expect(saved('a').subtasks).toEqual(subtasks('a'));
    expect(env.readData().categories.map((category) => category.id)).toEqual(['home']);
    expect(env.readData().settings.lastView.destination).toBe('__all__');
  });
});

describe('language changes mid-workflow', () => {
  it('filters, chips, indicators and the open filter state follow the new language', async () => {
    await start();
    await toggleDue('Просроченные');
    await env.user.click(screen.getByRole('radio', { name: 'EN' }));
    expect(screen.getByRole('button', { name: 'Remove “Overdue”' })).toBeInTheDocument();
    expect(allCardTitles()).toEqual(['Альфа']);
    expect(card('Альфа')).toHaveTextContent('Overdue · Oct 18');
    expect(within(card('Альфа')).getByRole('img', { name: 'Subtasks: 1 of 2 done' })).toBeInTheDocument();
    await env.user.click(screen.getByRole('button', { name: 'Альфа' }));
    expect(screen.getByRole('dialog', { name: 'Edit task' })).toBeInTheDocument();
    await waitFor(() => expect(env.readData().settings.language).toBe('en'));
  });
});

describe('save errors', () => {
  it('a failed edit is reported, kept on screen, and saved by Retry (focus stays usable)', async () => {
    await start();
    await waitFor(() => expect(env.readData().tasks).toHaveLength(5));
    env.failNextSaves(1);
    await editDue('Гамма', 'Завтра');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось сохранить изменения.');
    expect(card('Гамма').querySelector('.due')).toHaveAttribute('data-due-state', 'tomorrow');
    expect(saved('c').dueDate).toBe('2026-10-21');
    const retry = within(alert).getByRole('button', { name: 'Повторить' });
    retry.focus();
    await env.user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(saved('c').dueDate).toBe('2026-10-22');
    // The notice is gone; keyboard focus must not be dropped to the page.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toHaveAccessibleName('Новая задача');
  });

  it('a failed bulk update is reported and never shown as saved; retry writes it', async () => {
    await start();
    await waitFor(() => expect(env.readData().tasks).toHaveLength(5));
    await toList();
    env.failNextSaves(1);
    await select('Альфа', 'Гамма');
    await env.user.selectOptions(within(toolbar()).getByRole('combobox', { name: 'Изменить приоритет выбранных задач' }), 'Низкий');
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить изменения.');
    expect(saved('a').priority).toBe('high');
    await env.user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect([saved('a').priority, saved('c').priority]).toEqual(['low', 'low']));
    expect(saved('a').subtasks).toEqual(subtasks('a'));
  });

  it('dismissing a startup notice keeps keyboard focus in the app', async () => {
    const bridge = createBridge();
    bridge.temp.writeText('taskflow-data.json', '{ broken');
    bridge.temp.writeJson('taskflow-data.json.bak', seeded());
    env = await renderApp({ temp: bridge.temp });
    const dismiss = screen.getByRole('button', { name: 'Скрыть' });
    dismiss.focus();
    await env.user.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: 'Скрыть' })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe('everything survives a restart', () => {
  it('a task created with every field, subtasks and a category reloads identically', async () => {
    await start();
    await env.user.click(screen.getByRole('button', { name: 'Новая задача' }));
    const dialog = screen.getByRole('dialog', { name: 'Новая задача' });
    await env.user.type(within(dialog).getByRole('textbox', { name: /Название/ }), 'Полная задача');
    await env.user.type(within(dialog).getByRole('textbox', { name: /Описание/ }), 'Строка один');
    await env.user.click(within(dialog).getByRole('radio', { name: 'Высокий' }));
    await env.user.click(within(dialog).getByRole('button', { name: /Срок/ }));
    await env.user.click(screen.getByRole('button', { name: /^Следующая неделя:/ }));
    await env.user.selectOptions(within(dialog).getByRole('combobox', { name: /Категория/ }), 'Дом');
    await env.user.type(within(dialog).getByRole('textbox', { name: /Метки/ }), 'Финансы{Enter}');
    await env.user.click(within(dialog).getByRole('button', { name: 'Добавить подзадачи' }));
    await env.user.type(within(dialog).getByRole('textbox', { name: 'Новая подзадача' }), 'Шаг 1{Enter}Шаг 2{Enter}');
    await env.user.click(within(dialog).getByRole('checkbox', { name: 'Подзадача «Шаг 1» выполнена' }));
    await env.user.click(within(dialog).getByRole('button', { name: 'Создать задачу' }));
    await waitFor(() => expect(env.readData().tasks.some((task) => task.title === 'Полная задача')).toBe(true));
    const stored = env.readData().tasks.find((task) => task.title === 'Полная задача');
    expect(stored).toMatchObject({ description: 'Строка один', priority: 'high', dueDate: '2026-10-26', categoryId: 'home', labels: ['Финансы'], status: 'todo' });
    expect(stored.subtasks.map((subtask) => [subtask.title, subtask.done])).toEqual([['Шаг 1', true], ['Шаг 2', false]]);

    const temp = env.temp;
    env.unmount();
    env = await renderApp({ temp });
    expect(env.boot.status).toBe('loaded');
    expect(env.readData().tasks.find((task) => task.id === stored.id)).toEqual(stored);
    expect(within(card('Полная задача')).getByRole('img', { name: 'Подзадачи: выполнено 1 из 2' })).toBeInTheDocument();
    expect(toastMessages()).toEqual([]);
  });
});
