// Board/List switching, List View status changes, search, filters, sorting, statistics, empty states.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXED_TODAY, makeCategory, makeDocument, makeTask } from '../helpers/fixtures.js';
import { allCardTitles, cardTitles, column, heading, listRows, navButton, statsText, toastMessages } from '../helpers/queries.js';
import { renderApp } from '../helpers/renderApp.jsx';

let env;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_TODAY);
});
afterEach(() => {
  vi.useRealTimers();
  env?.temp.remove();
});

const toList = (user) => user.click(screen.getByRole('button', { name: 'Список' }));
const toBoard = (user) => user.click(screen.getByRole('button', { name: 'Доска' }));
const search = async (user, text) => {
  const box = screen.getByRole('searchbox', { name: 'Поиск по названию и описанию' });
  await user.clear(box);
  if (text) await user.type(box, text);
};
const openFilters = (user) => user.click(screen.getByRole('button', { name: /^Фильтры/ }));
const sortBy = (user, label) => user.selectOptions(screen.getByRole('combobox', { name: /Сортировка/ }), label);

describe('Board and List View', () => {
  it('switching views keeps the category and the same tasks', async () => {
    env = await renderApp({
      document: makeDocument({
        categories: [makeCategory({ id: 'c', name: 'Работа' })],
        tasks: [makeTask({ title: 'A', categoryId: 'c' }), makeTask({ title: 'B', categoryId: 'c', status: 'done' }), makeTask({ title: 'C' })],
      }),
    });
    const { user } = env;
    await user.click(navButton('Работа'));
    expect(allCardTitles().sort()).toEqual(['A', 'B']);
    await toList(user);
    expect(heading()).toBe('Работа');
    expect(listRows().map((row) => row.title)).toEqual(['A', 'B']);
    expect(screen.queryByRole('columnheader', { name: 'Категория' })).not.toBeInTheDocument();
    await toBoard(user);
    expect(allCardTitles().sort()).toEqual(['A', 'B']);
    expect(env.readData().tasks).toHaveLength(3);
  });

  it('List View shows all columns in All tasks, grouped by status in manual order', async () => {
    env = await renderApp();
    await toList(env.user);
    const [selectHeader, ...headers] = screen.getAllByRole('columnheader');
    // The first column holds the select-all checkbox for bulk actions.
    expect(within(selectHeader).getByRole('checkbox', { name: 'Выбрать все видимые задачи' })).toBeInTheDocument();
    expect(headers.map((header) => header.textContent)).toEqual(['Задача', 'Категория', 'Статус', 'Приоритет', 'Срок', 'Метки', 'Действия']);
    expect(listRows().map((row) => row.status)).toEqual(['todo', 'todo', 'todo', 'inProgress', 'inProgress', 'inProgress', 'done', 'done']);
  });

  it('changes status from the List View (task moves to the end of the new column)', async () => {
    env = await renderApp();
    const { user } = env;
    await toList(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Статус задачи «Подготовить план спринта»' }), 'Готово');
    expect(listRows().at(-1)).toEqual({ title: 'Подготовить план спринта', status: 'done' });
    expect(toastMessages()).toContain('Задача «Подготовить план спринта» перемещена в «Готово»');
    expect(statsText()).toMatch(/3\s*Выполнено/);
    await toBoard(user);
    expect(cardTitles('Готово').at(-1)).toBe('Подготовить план спринта');
    await waitFor(() => expect(env.readData().tasks.find((task) => task.id === 'sample-t1')).toMatchObject({ status: 'done', order: 2 }));
  });

  it('marks overdue dates in the List View with text, not only color', async () => {
    env = await renderApp();
    await toList(env.user);
    const row = screen.getAllByRole('row').find((item) => item.textContent.includes('Исправить задержку уведомлений'));
    expect(row).toHaveTextContent('Просрочено');
  });

  it('opens the shared edit dialog and deletes from the List View', async () => {
    env = await renderApp();
    const { user } = env;
    await toList(user);
    await user.click(screen.getByRole('button', { name: 'Собрать отзывы пользователей' }));
    expect(screen.getByRole('dialog', { name: 'Редактирование задачи' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Отмена' }));
    await user.click(screen.getByRole('button', { name: 'Удалить задачу «Собрать отзывы пользователей»' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить' }));
    expect(listRows()).toHaveLength(7);
  });
});

describe('search, filters and sorting', () => {
  it('searches titles and descriptions in both views and shows active state', async () => {
    env = await renderApp();
    const { user } = env;
    await search(user, '  СПРИНТА ');
    expect(allCardTitles()).toEqual(['Подготовить план спринта']);
    expect(screen.getByText('Показано 1 из 8')).toBeInTheDocument();
    expect(screen.getByText('Поиск: «СПРИНТА»')).toBeInTheDocument();
    // Moving between columns stays possible; reordering is off (the hint says so).
    expect(screen.queryAllByRole('button', { name: /^Переместить задачу/ })).toHaveLength(1);
    expect(screen.getByText(/можно переносить между колонками, но не менять их порядок/)).toBeInTheDocument();

    await search(user, 'спящего');
    expect(allCardTitles()).toEqual(['Исправить задержку уведомлений']);
    await toList(user);
    expect(listRows().map((row) => row.title)).toEqual(['Исправить задержку уведомлений']);
  });

  it('distinguishes "no matches" from "no tasks" and resets', async () => {
    env = await renderApp();
    const { user } = env;
    await search(user, 'нет такого');
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
    expect(statsText()).toMatch(/8\s*Всего/);
    await user.click(screen.getAllByRole('button', { name: 'Сбросить всё' })[0]);
    expect(allCardTitles()).toHaveLength(8);
    expect(screen.getAllByRole('button', { name: /^Переместить задачу/ })).toHaveLength(8);
  });

  it('combines status, priority and label filters; chips remove single filters', async () => {
    env = await renderApp();
    const { user } = env;
    await openFilters(user);
    await user.click(screen.getByRole('checkbox', { name: 'Высокий' }));
    await user.click(screen.getByRole('checkbox', { name: 'В работе' }));
    expect(screen.getByRole('button', { name: /^Фильтры/ })).toHaveTextContent('2');
    expect(screen.queryByRole('region', { name: 'К выполнению' })).not.toBeInTheDocument();
    expect(cardTitles('В работе')).toEqual(['Переработать экран настроек', 'Исправить задержку уведомлений']);

    await user.click(screen.getByRole('checkbox', { name: 'Дизайн' }));
    expect(allCardTitles()).toEqual(['Переработать экран настроек']);

    await user.click(screen.getByRole('button', { name: 'Убрать «Дизайн»' }));
    expect(allCardTitles()).toHaveLength(2);
    expect(env.readData().tasks).toHaveLength(8);
  });

  it('sorts by due date, priority and title without changing the saved manual order', async () => {
    env = await renderApp();
    const { user } = env;
    const savedOrder = () => env.readData().tasks.map((task) => `${task.id}:${task.order}`).sort();
    await waitFor(() => expect(env.readData().tasks).toHaveLength(8));
    const before = savedOrder();

    await sortBy(user, 'По сроку');
    expect(cardTitles('В работе')).toEqual(['Исправить задержку уведомлений', 'Переработать экран настроек', 'Написать тесты для модуля отчётов']);
    await sortBy(user, 'По приоритету');
    expect(cardTitles('К выполнению')).toEqual(['Подготовить план спринта', 'Обновить руководство для новичков', 'Собрать отзывы пользователей']);
    await sortBy(user, 'По названию');
    expect(cardTitles('К выполнению')).toEqual(['Обновить руководство для новичков', 'Подготовить план спринта', 'Собрать отзывы пользователей']);
    await toList(user);
    expect(listRows().map((row) => row.title)[0]).toBe('Исправить задержку уведомлений');
    await sortBy(user, 'Ручной порядок');
    await toBoard(user);
    expect(cardTitles('К выполнению')).toEqual(['Подготовить план спринта', 'Обновить руководство для новичков', 'Собрать отзывы пользователей']);
    expect(savedOrder()).toEqual(before);
  });

  it('puts tasks without a due date last when sorting by due date', async () => {
    env = await renderApp({
      document: makeDocument({ tasks: [makeTask({ title: 'Без срока', order: 0 }), makeTask({ title: 'Ранний', dueDate: '2026-10-22', order: 1 })] }),
    });
    await sortBy(env.user, 'По сроку');
    expect(cardTitles('К выполнению')).toEqual(['Ранний', 'Без срока']);
  });
});

describe('statistics and empty states', () => {
  it('summarizes the whole destination (done tasks never overdue)', async () => {
    env = await renderApp();
    expect(statsText()).toMatch(/8\s*Всего\s*2\s*Выполнено\s*1\s*Просрочено.*25%/);
    await env.user.click(screen.getByRole('button', { name: 'Удалить задачу «Исправить задержку уведомлений»' }));
    await env.user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить' }));
    expect(statsText()).toMatch(/7\s*Всего\s*2\s*Выполнено\s*0\s*Просрочено.*29%/);
  });

  it('shows zero tasks clearly with a create action', async () => {
    env = await renderApp({ document: makeDocument() });
    const { user } = env;
    expect(statsText()).toMatch(/0\s*Всего\s*0\s*Выполнено\s*0\s*Просрочено.*—/);
    expect(screen.getByText(/Задач пока нет/)).toBeInTheDocument();
    expect(within(column('К выполнению')).getByText('Перетащите задачу сюда')).toBeInTheDocument();
    await toList(user);
    expect(screen.getByText('Здесь пока нет задач.')).toBeInTheDocument();
    await search(user, 'x');
    expect(screen.queryByText('Ничего не найдено')).not.toBeInTheDocument();
  });

  it('empty category offers New task with that category preselected', async () => {
    env = await renderApp({ document: makeDocument({ categories: [makeCategory({ id: 'e', name: 'Пустая' })], tasks: [makeTask()] }) });
    const { user } = env;
    await user.click(navButton('Пустая'));
    expect(screen.getByText(/В этом разделе пока нет задач/)).toBeInTheDocument();
    const status = screen.getByText(/В этом разделе пока нет задач/).closest('[role="status"]');
    await user.click(within(status).getByRole('button', { name: 'Новая задача' }));
    expect(screen.getByRole('combobox', { name: 'Категория' }).selectedOptions[0]).toHaveTextContent('Пустая');
  });
});
