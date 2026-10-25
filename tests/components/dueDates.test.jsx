// Due-date indicators, quick due dates and date filters through the real UI and storage.
// "Today" is Wednesday 21 Oct 2026 (controlled clock).
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXED_TODAY, makeCategory, makeDocument, makeTask } from '../helpers/fixtures.js';
import { allCardTitles, card, listRows, navButton, statsText, toastMessages } from '../helpers/queries.js';
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

const seeded = () =>
  makeDocument({
    categories: [makeCategory({ id: 'work', name: 'Работа' })],
    tasks: [
      makeTask({ id: 'late', title: 'Просроченная', dueDate: '2026-10-18', order: 0, categoryId: 'work' }),
      makeTask({ id: 'now', title: 'Сегодняшняя', dueDate: '2026-10-21', status: 'inProgress', order: 0, categoryId: 'work' }),
      makeTask({ id: 'next', title: 'Завтрашняя', dueDate: '2026-10-22', order: 1 }),
      makeTask({ id: 'later', title: 'Будущая', dueDate: '2026-11-15', order: 2, categoryId: 'work' }),
      makeTask({ id: 'free', title: 'Без даты', order: 3 }),
      makeTask({ id: 'oldDone', title: 'Сделанная давно', dueDate: '2026-10-01', status: 'done', order: 0 }),
      makeTask({ id: 'doneToday', title: 'Сделанная сегодня', dueDate: '2026-10-21', status: 'done', order: 1 }),
      makeTask({
        id: 'parent',
        title: 'С подзадачами',
        dueDate: '2026-10-20',
        order: 4,
        subtasks: [
          { id: 's1', title: 'Первая', done: true },
          { id: 's2', title: 'Вторая', done: false },
        ],
      }),
    ],
  });

const start = async (document = seeded()) => {
  env = await renderApp({ document });
  return env;
};
const due = (container) => container.querySelector('.due');
const dueOf = (title) => due(card(title));
const saved = (id) => env.readData().tasks.find((task) => task.id === id);
const toList = () => env.user.click(screen.getByRole('button', { name: 'Список' }));
const rowOf = (title) => screen.getAllByRole('row').find((row) => within(row).queryByRole('button', { name: title }));
const openFilters = () => env.user.click(screen.getByRole('button', { name: /^Фильтры/ }));
const toggleDueFilter = async (name) => {
  await openFilters();
  await env.user.click(screen.getByRole('checkbox', { name }));
  await env.user.keyboard('{Escape}');
};
const openEditor = async (title) => {
  await env.user.click(screen.getByRole('button', { name: `Редактировать задачу «${title}»` }));
  return screen.getByRole('dialog', { name: 'Редактирование задачи' });
};
const openDueMenu = (dialog) => env.user.click(within(dialog).getByRole('button', { name: /Срок/ }));
const quick = (name) => screen.getByRole('button', { name: new RegExp(`^${name}:`) });

describe('due-date indicators', () => {
  it('Board cards distinguish overdue, today, tomorrow and later dates by text and icon', async () => {
    await start();
    const late = dueOf('Просроченная');
    expect(late).toHaveAttribute('data-due-state', 'overdue');
    expect(late).toHaveTextContent('Просрочено · 18 окт.');
    expect(late).toHaveTextContent('Просрочено, срок был 18 окт.');
    expect(late.querySelector('svg')).not.toBeNull();

    const today = dueOf('Сегодняшняя');
    expect(today).toHaveAttribute('data-due-state', 'today');
    expect(today.querySelector('time')).toHaveTextContent(/^Сегодня$/);
    expect(today).toHaveTextContent('Срок сегодня, 21 окт.');

    expect(dueOf('Завтрашняя').querySelector('time')).toHaveTextContent(/^Завтра$/);
    expect(dueOf('Завтрашняя')).toHaveAttribute('data-due-state', 'tomorrow');
    const later = dueOf('Будущая');
    expect(later).toHaveAttribute('data-due-state', 'upcoming');
    expect(later.querySelector('time')).toHaveTextContent(/^15 нояб\.$/);
    expect(later).not.toHaveTextContent(/Просрочено|Сегодня/);

    // The overdue, today and later icons differ (not color alone).
    const icons = [late, today, later].map((node) => node.querySelector('svg').innerHTML);
    expect(new Set(icons).size).toBe(3);
  });

  it('completed tasks are never shown as overdue; tasks without a date show nothing', async () => {
    await start();
    expect(dueOf('Сделанная давно')).toHaveAttribute('data-due-state', 'done');
    expect(dueOf('Сделанная давно')).not.toHaveTextContent('Просрочено');
    expect(dueOf('Сделанная сегодня')).toHaveAttribute('data-due-state', 'done');
    expect(dueOf('Без даты')).toBeNull();
    // Statistics agree with the indicators: two open overdue tasks.
    expect(statsText()).toMatch(/2\s*Просрочено/);
  });

  it('List View shows the same states in the due column', async () => {
    await start();
    await toList();
    const state = (title) => due(rowOf(title))?.getAttribute('data-due-state') ?? null;
    expect(state('Просроченная')).toBe('overdue');
    expect(rowOf('Просроченная')).toHaveTextContent('18 окт. 2026 г.');
    expect(rowOf('Просроченная')).toHaveTextContent('Просрочено');
    expect(state('Сегодняшняя')).toBe('today');
    expect(due(rowOf('Сегодняшняя')).querySelector('time')).toHaveTextContent(/^Сегодня$/);
    expect(state('Завтрашняя')).toBe('tomorrow');
    expect(state('Будущая')).toBe('upcoming');
    expect(due(rowOf('Будущая')).querySelector('time')).toHaveTextContent('15 нояб. 2026 г.');
    expect(state('Сделанная давно')).toBe('done');
    expect(state('Без даты')).toBeNull();
    expect(rowOf('Без даты')).toHaveTextContent('—');
  });

  it('a subtask parent shows its due state and subtask progress side by side', async () => {
    await start();
    const parent = card('С подзадачами');
    expect(due(parent)).toHaveAttribute('data-due-state', 'overdue');
    expect(within(parent).getByRole('img', { name: 'Подзадачи: выполнено 1 из 2' })).toBeInTheDocument();
  });

  it('English labels', async () => {
    await start();
    await env.user.click(screen.getByRole('radio', { name: 'EN' }));
    expect(dueOf('Просроченная')).toHaveTextContent('Overdue · Oct 18');
    expect(dueOf('Просроченная')).toHaveTextContent('Overdue, was due Oct 18');
    expect(dueOf('Сегодняшняя').querySelector('time')).toHaveTextContent(/^Today$/);
    expect(dueOf('Сегодняшняя')).toHaveTextContent('Due today, Oct 21');
    expect(dueOf('Завтрашняя')).toHaveTextContent('Due tomorrow, Oct 22');
    expect(dueOf('Будущая')).toHaveTextContent('Due Nov 15');
  });
});

describe('quick due dates', () => {
  it('the task editor offers Today, Tomorrow, In 7 days and Next week with the resulting dates', async () => {
    await start();
    const dialog = await openEditor('Без даты');
    await openDueMenu(dialog);
    const group = screen.getByRole('group', { name: 'Быстрый выбор срока' });
    expect(within(group).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual([
      'Сегодня: среда, 21 октября',
      'Завтра: четверг, 22 октября',
      'Через 7 дней: среда, 28 октября',
      'Следующая неделя: понедельник, 26 октября',
      'Без срока',
    ]);
    await env.user.click(quick('Завтра'));
    expect(within(dialog).getByRole('button', { name: /Срок/ })).toHaveTextContent('22 октября 2026 г.');
    await env.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(dueOf('Без даты').querySelector('time')).toHaveTextContent(/^Завтра$/);
    await waitFor(() => expect(saved('free').dueDate).toBe('2026-10-22'));
  });

  it('each quick choice sets the expected local date, and the current one is marked', async () => {
    await start();
    for (const [name, expected] of [
      ['Сегодня', '2026-10-21'],
      ['Через 7 дней', '2026-10-28'],
      ['Следующая неделя', '2026-10-26'],
    ]) {
      const dialog = await openEditor('Будущая');
      await openDueMenu(dialog);
      await env.user.click(quick(name));
      await env.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
      await waitFor(() => expect(saved('later').dueDate).toBe(expected));
    }
    const dialog = await openEditor('Будущая');
    await openDueMenu(dialog);
    expect(quick('Следующая неделя')).toHaveAttribute('aria-pressed', 'true');
    expect(quick('Сегодня')).toHaveAttribute('aria-pressed', 'false');
  });

  it('clearing the due date (quick "No due date" and the clear button) makes the task neutral', async () => {
    await start();
    let dialog = await openEditor('Просроченная');
    await openDueMenu(dialog);
    await env.user.click(screen.getByRole('button', { name: 'Без срока' }));
    await env.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(dueOf('Просроченная')).toBeNull();
    await waitFor(() => expect(saved('late').dueDate).toBeNull());

    dialog = await openEditor('Будущая');
    await env.user.click(within(dialog).getByRole('button', { name: 'Убрать срок' }));
    await env.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(saved('later').dueDate).toBeNull());
    expect(statsText()).toMatch(/1\s*Просрочено/);
  });

  it('English "Next week" follows the English calendar (weeks start on Sunday)', async () => {
    await start();
    await env.user.click(screen.getByRole('radio', { name: 'EN' }));
    await env.user.click(screen.getByRole('button', { name: 'Edit task “Без даты”' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit task' });
    await env.user.click(within(dialog).getByRole('button', { name: /Due date/ }));
    expect(screen.getByRole('group', { name: 'Quick due dates' })).toBeInTheDocument();
    expect(quick('Next week')).toHaveAccessibleName('Next week: Sunday, October 25');
    expect(quick('In 7 days')).toHaveAccessibleName('In 7 days: Wednesday, October 28');
    await env.user.click(quick('Next week'));
    await env.user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved('free').dueDate).toBe('2026-10-25'));
  });

  it('bulk due date in List View offers the same quick choices', async () => {
    await start();
    await toList();
    await env.user.click(screen.getByRole('checkbox', { name: 'Выбрать задачу «Без даты»' }));
    await env.user.click(screen.getByRole('checkbox', { name: 'Выбрать задачу «Будущая»' }));
    const toolbar = screen.getByRole('toolbar', { name: 'Действия с выбранными задачами' });
    await env.user.click(within(toolbar).getByRole('button', { name: /Срок/ }));
    await env.user.click(quick('Завтра'));
    expect(toastMessages()).toContain('Срок 22 октября 2026 г. установлен для 2 задач');
    await waitFor(() => expect([saved('free').dueDate, saved('later').dueDate]).toEqual(['2026-10-22', '2026-10-22']));
    expect(due(rowOf('Будущая'))).toHaveAttribute('data-due-state', 'tomorrow');
    expect(saved('late').dueDate).toBe('2026-10-18');
  });

  it('changing a parent due date leaves its subtasks untouched', async () => {
    await start();
    const dialog = await openEditor('С подзадачами');
    await openDueMenu(dialog);
    await env.user.click(quick('Через 7 дней'));
    await env.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(saved('parent').dueDate).toBe('2026-10-28'));
    expect(saved('parent').subtasks).toEqual([
      { id: 's1', title: 'Первая', done: true },
      { id: 's2', title: 'Вторая', done: false },
    ]);
    expect(saved('parent').status).toBe('todo');
  });
});

describe('date filters', () => {
  it('Overdue, Due today and Upcoming filter the Board; no-date tasks never match', async () => {
    await start();
    await toggleDueFilter('Просроченные');
    expect(allCardTitles().sort()).toEqual(['Просроченная', 'С подзадачами']);
    expect(screen.getByText('Показано 2 из 8')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Убрать «Просроченные»' })).toBeInTheDocument();

    await toggleDueFilter('Просроченные');
    await toggleDueFilter('На сегодня');
    // Today includes a task already completed today.
    expect(allCardTitles().sort()).toEqual(['Сделанная сегодня', 'Сегодняшняя']);

    await toggleDueFilter('На сегодня');
    await toggleDueFilter('Предстоящие');
    expect(allCardTitles().sort()).toEqual(['Будущая', 'Завтрашняя']);

    // Several date filters combine; "Без даты" never appears.
    await toggleDueFilter('Просроченные');
    await toggleDueFilter('На сегодня');
    expect(allCardTitles()).not.toContain('Без даты');
    expect(allCardTitles()).toHaveLength(6);
    expect(screen.getByRole('button', { name: /^Фильтры/ })).toHaveTextContent('3');
  });

  it('filters update immediately after status and due-date changes', async () => {
    await start();
    await toList();
    await toggleDueFilter('Просроченные');
    expect(listRows().map((row) => row.title)).toEqual(['Просроченная', 'С подзадачами']);

    // Completing an overdue task removes it from Overdue.
    await env.user.selectOptions(screen.getByRole('combobox', { name: 'Статус задачи «Просроченная»' }), 'Готово');
    expect(listRows().map((row) => row.title)).toEqual(['С подзадачами']);

    // Moving the other one to tomorrow removes it too.
    await env.user.click(screen.getByRole('button', { name: 'Редактировать задачу «С подзадачами»' }));
    const dialog = screen.getByRole('dialog', { name: 'Редактирование задачи' });
    await openDueMenu(dialog);
    await env.user.click(quick('Завтра'));
    await env.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(screen.queryAllByRole('row').filter((row) => within(row).queryAllByRole('cell').length > 1)).toHaveLength(0);

    // Reopening the completed task brings it back.
    await env.user.click(screen.getByRole('button', { name: 'Убрать «Просроченные»' }));
    await env.user.selectOptions(screen.getByRole('combobox', { name: 'Статус задачи «Просроченная»' }), 'К выполнению');
    await toggleDueFilter('Просроченные');
    expect(listRows().map((row) => row.title)).toEqual(['Просроченная']);
  });

  it('works together with search, categories and sorting', async () => {
    await start();
    await toList();
    await toggleDueFilter('Предстоящие');
    await toggleDueFilter('На сегодня');
    await env.user.selectOptions(screen.getByRole('combobox', { name: /Сортировка/ }), 'По сроку');
    expect(listRows().map((row) => row.title)).toEqual(['Сегодняшняя', 'Сделанная сегодня', 'Завтрашняя', 'Будущая']);

    await env.user.type(screen.getByRole('searchbox', { name: 'Поиск по названию и описанию' }), 'шняя');
    expect(listRows().map((row) => row.title)).toEqual(['Сегодняшняя', 'Завтрашняя']);

    await env.user.click(navButton('Работа'));
    // The view (search, filters, sort) stays while the category narrows the tasks.
    expect(listRows().map((row) => row.title)).toEqual(['Сегодняшняя']);
    expect(env.readData().tasks).toHaveLength(8);
  });

  it('bulk selection only covers the filtered tasks, and bulk date changes update the filter', async () => {
    await start();
    await toList();
    await toggleDueFilter('Просроченные');
    await env.user.click(screen.getByRole('checkbox', { name: 'Выбрать все видимые задачи' }));
    const toolbar = screen.getByRole('toolbar', { name: 'Действия с выбранными задачами' });
    expect(toolbar).toHaveTextContent('Выбраны 2 задачи');
    await env.user.click(within(toolbar).getByRole('button', { name: /Срок/ }));
    await env.user.click(quick('Сегодня'));
    await waitFor(() => expect([saved('late').dueDate, saved('parent').dueDate]).toEqual(['2026-10-21', '2026-10-21']));
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
    expect(saved('later').dueDate).toBe('2026-11-15');
    expect(saved('parent').subtasks.map((subtask) => subtask.done)).toEqual([true, false]);
  });

  it('date filters keep moving between columns but not reordering, like other filters, and Reset clears them', async () => {
    await start();
    await toggleDueFilter('На сегодня');
    expect(screen.getByText(/можно переносить между колонками, но не менять их порядок/)).toBeInTheDocument();
    await env.user.click(screen.getByRole('button', { name: 'Сбросить всё' }));
    expect(allCardTitles()).toHaveLength(8);
  });

  it('English filter labels and chips', async () => {
    await start();
    await env.user.click(screen.getByRole('radio', { name: 'EN' }));
    await env.user.click(screen.getByRole('button', { name: /^Filters/ }));
    const group = screen.getByRole('group', { name: 'Due date' });
    expect(within(group).getAllByRole('checkbox').map((box) => box.closest('label').textContent)).toEqual(['Overdue', 'Due today', 'Upcoming']);
    await env.user.click(within(group).getByRole('checkbox', { name: 'Upcoming' }));
    await env.user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Remove “Upcoming”' })).toBeInTheDocument();
    expect(allCardTitles().sort()).toEqual(['Будущая', 'Завтрашняя']);
  });
});
