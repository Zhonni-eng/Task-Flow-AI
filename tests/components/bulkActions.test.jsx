// List View multi-selection and bulk actions through the real UI and real storage.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXED_TODAY, makeCategory, makeDocument, makeTask } from '../helpers/fixtures.js';
import { listRows, navButton, toastMessages } from '../helpers/queries.js';
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
    categories: [makeCategory({ id: 'work', name: 'Работа', order: 0 }), makeCategory({ id: 'home', name: 'Дом', order: 1 })],
    tasks: [
      makeTask({ id: 'a', title: 'Альфа', status: 'todo', order: 0, categoryId: 'work', priority: 'high', dueDate: '2026-10-25', labels: ['x'], description: 'описание альфа' }),
      makeTask({ id: 'b', title: 'Бета', status: 'todo', order: 1, categoryId: 'home', priority: 'low' }),
      makeTask({ id: 'c', title: 'Гамма', status: 'todo', order: 2, priority: 'medium', dueDate: '2026-11-01' }),
      makeTask({ id: 'd', title: 'Дельта', status: 'inProgress', order: 0, categoryId: 'work', priority: 'medium' }),
      makeTask({ id: 'e', title: 'Эпсилон', status: 'inProgress', order: 1, priority: 'high', labels: ['y'] }),
      makeTask({ id: 'f', title: 'Зета', status: 'done', order: 0, categoryId: 'home', priority: 'low', dueDate: '2026-10-01' }),
    ],
  });

const start = async (document = seeded()) => {
  env = await renderApp({ document });
  await env.user.click(screen.getByRole('button', { name: 'Список' }));
  return env;
};
const rowBox = (title) => screen.getByRole('checkbox', { name: `Выбрать задачу «${title}»` });
const selectAllBox = () => screen.getByRole('checkbox', { name: 'Выбрать все видимые задачи' });
const toolbar = () => screen.queryByRole('toolbar', { name: 'Действия с выбранными задачами' });
const select = async (...titles) => {
  for (const title of titles) await env.user.click(rowBox(title));
};
const saved = (id) => env.readData().tasks.find((task) => task.id === id);
const savedColumn = (status) =>
  env
    .readData()
    .tasks.filter((task) => task.status === status)
    .sort((x, y) => x.order - y.order)
    .map((task) => `${task.id}:${task.order}`);

describe('selecting tasks', () => {
  it('selects and deselects a single task without opening the editor', async () => {
    await start();
    await env.user.click(rowBox('Бета'));
    expect(rowBox('Бета')).toBeChecked();
    expect(toolbar()).toHaveTextContent('Выбрана 1 задача');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await env.user.click(rowBox('Бета'));
    expect(rowBox('Бета')).not.toBeChecked();
    expect(toolbar()).not.toBeInTheDocument();
  });

  it('selects several tasks with different statuses and categories; the count stays accurate', async () => {
    await start();
    await select('Альфа', 'Эпсилон', 'Зета');
    expect(toolbar()).toHaveTextContent('Выбраны 3 задачи');
    expect(selectAllBox()).not.toBeChecked();
    expect(selectAllBox().indeterminate).toBe(true);
    expect(listRows().filter((row) => row.selected).map((row) => row.title)).toEqual(['Альфа', 'Эпсилон', 'Зета']);
    await select('Бета', 'Гамма', 'Дельта');
    expect(toolbar()).toHaveTextContent('Выбрано 6 задач');
    expect(selectAllBox()).toBeChecked();
  });

  it('clear selection removes every check and hides the toolbar', async () => {
    await start();
    await env.user.click(selectAllBox());
    await env.user.click(within(toolbar()).getByRole('button', { name: 'Снять выделение' }));
    expect(toolbar()).not.toBeInTheDocument();
    expect(listRows().some((row) => row.selected)).toBe(false);
  });

  it('works with the keyboard (Space toggles a focused checkbox)', async () => {
    await start();
    rowBox('Гамма').focus();
    await env.user.keyboard(' ');
    expect(rowBox('Гамма')).toBeChecked();
    expect(toolbar()).toHaveTextContent('Выбрана 1 задача');
  });
});

describe('selection follows the visible result', () => {
  it('select-all in a category selects only that category, and actions change only those tasks', async () => {
    await start();
    await env.user.click(navButton('Работа'));
    await env.user.click(selectAllBox());
    expect(toolbar()).toHaveTextContent('Выбраны 2 задачи');
    await env.user.click(within(toolbar()).getByRole('button', { name: /Выполнено/ }));
    expect(toastMessages()).toContain('2 задачи отмечены выполненными');
    await waitFor(() => expect(saved('a').status).toBe('done'));
    expect(saved('d').status).toBe('done');
    expect(['b', 'c', 'e'].map((id) => saved(id).status)).toEqual(['todo', 'todo', 'inProgress']);
  });

  it('search deselects tasks it hides; they stay unselected when the search is cleared', async () => {
    await start();
    await select('Бета', 'Гамма');
    await env.user.type(screen.getByRole('searchbox'), 'Гамма');
    expect(toolbar()).toHaveTextContent('Выбрана 1 задача');
    // Every visible task is selected, so select-all reads as checked.
    expect(selectAllBox()).toBeChecked();
    await env.user.clear(screen.getByRole('searchbox'));
    expect(listRows().filter((row) => row.selected).map((row) => row.title)).toEqual(['Гамма']);
  });

  it('filters narrow the selection and actions never reach hidden tasks', async () => {
    await start();
    await env.user.click(selectAllBox());
    await env.user.click(screen.getByRole('button', { name: /^Фильтры/ }));
    await env.user.click(screen.getByRole('checkbox', { name: 'Высокий' }));
    await env.user.keyboard('{Escape}');
    expect(toolbar()).toHaveTextContent('Выбраны 2 задачи');
    await env.user.selectOptions(within(toolbar()).getByRole('combobox', { name: 'Изменить приоритет выбранных задач' }), 'Низкий');
    expect(toastMessages()).toContain('Приоритет «Низкий» установлен для 2 задач');
    await waitFor(() => expect(saved('a').priority).toBe('low'));
    expect(saved('e').priority).toBe('low');
    expect(saved('c').priority).toBe('medium');
    expect(saved('d').priority).toBe('medium');
  });

  it('sorting keeps the selection; switching category or to Board clears it', async () => {
    await start();
    await select('Альфа', 'Зета');
    await env.user.selectOptions(screen.getByRole('combobox', { name: /Сортировка/ }), 'По названию');
    expect(toolbar()).toHaveTextContent('Выбраны 2 задачи');
    await env.user.click(navButton('Дом'));
    expect(toolbar()).not.toBeInTheDocument();
    await env.user.click(navButton('Все задачи'));
    await select('Бета');
    await env.user.click(screen.getByRole('button', { name: 'Доска' }));
    await env.user.click(screen.getByRole('button', { name: 'Список' }));
    expect(toolbar()).not.toBeInTheDocument();
  });

  it('a selected task deleted from its row disappears from the selection', async () => {
    await start();
    await select('Альфа', 'Бета');
    await env.user.click(screen.getByRole('button', { name: 'Удалить задачу «Альфа»' }));
    await env.user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить' }));
    expect(toolbar()).toHaveTextContent('Выбрана 1 задача');
  });

  it('editing a selected task so it no longer matches the search deselects it', async () => {
    await start();
    await env.user.type(screen.getByRole('searchbox'), 'та');
    await select('Бета', 'Дельта');
    await env.user.click(screen.getByRole('button', { name: 'Бета' }));
    const title = screen.getByRole('textbox', { name: /Название/ });
    await env.user.clear(title);
    await env.user.type(title, 'Другое{Enter}');
    expect(toolbar()).toHaveTextContent('Выбрана 1 задача');
  });
});

describe('bulk actions', () => {
  it('changes status, appending to the end of the target column and keeping other fields', async () => {
    await start();
    const before = structuredClone(seeded().tasks.find((task) => task.id === 'a'));
    await select('Альфа', 'Бета');
    await env.user.selectOptions(within(toolbar()).getByRole('combobox', { name: 'Изменить статус выбранных задач' }), 'В работе');
    expect(toastMessages()).toContain('2 задачи перемещены в «В работе»');
    expect(toolbar()).not.toBeInTheDocument();
    await waitFor(() => expect(savedColumn('inProgress')).toEqual(['d:0', 'e:1', 'a:2', 'b:3']));
    expect(savedColumn('todo')).toEqual(['c:0']);
    expect(saved('a')).toMatchObject({ id: 'a', title: before.title, description: before.description, labels: before.labels, categoryId: 'work', priority: 'high', dueDate: '2026-10-25', createdAt: before.createdAt });
  });

  it('marks tasks completed and counts only the ones that changed', async () => {
    await start();
    await select('Альфа', 'Зета');
    await env.user.click(within(toolbar()).getByRole('button', { name: /Выполнено/ }));
    expect(toastMessages()).toContain('1 задача отмечена выполненной');
    await waitFor(() => expect(savedColumn('done')).toEqual(['f:0', 'a:1']));
  });

  it('reports when nothing needed to change', async () => {
    await start();
    await select('Зета');
    await env.user.click(within(toolbar()).getByRole('button', { name: /Выполнено/ }));
    expect(toastMessages()).toContain('Выбранные задачи уже в этом состоянии — ничего не изменено.');
  });

  it('changes category, including back to Uncategorized, without creating categories', async () => {
    await start();
    await select('Альфа', 'Бета', 'Гамма');
    await env.user.selectOptions(within(toolbar()).getByRole('combobox', { name: 'Изменить категорию выбранных задач' }), 'Дом');
    expect(toastMessages()).toContain('2 задачи перенесены в «Дом»');
    await waitFor(() => expect(['a', 'b', 'c'].map((id) => saved(id).categoryId)).toEqual(['home', 'home', 'home']));
    await select('Альфа', 'Бета');
    await env.user.selectOptions(within(toolbar()).getByRole('combobox', { name: 'Изменить категорию выбранных задач' }), 'Без категории');
    await waitFor(() => expect([saved('a').categoryId, saved('b').categoryId]).toEqual([null, null]));
    expect(saved('c').categoryId).toBe('home');
    expect(env.readData().categories.map((category) => category.id)).toEqual(['work', 'home']);
  });

  it('changes priority', async () => {
    await start();
    await select('Бета', 'Зета');
    await env.user.selectOptions(within(toolbar()).getByRole('combobox', { name: 'Изменить приоритет выбранных задач' }), 'Высокий');
    await waitFor(() => expect([saved('b').priority, saved('f').priority]).toEqual(['high', 'high']));
    expect(saved('c').priority).toBe('medium');
  });

  it('sets a common due date and clears due dates', async () => {
    await start();
    await select('Бета', 'Гамма');
    await env.user.click(within(toolbar()).getByRole('button', { name: /Срок/ }));
    await env.user.click(screen.getByRole('button', { name: /28 октября 2026/ }));
    expect(toastMessages()).toContain('Срок 28 октября 2026 г. установлен для 2 задач');
    await waitFor(() => expect([saved('b').dueDate, saved('c').dueDate]).toEqual(['2026-10-28', '2026-10-28']));
    expect(saved('a').dueDate).toBe('2026-10-25');

    await select('Альфа', 'Гамма');
    await env.user.click(within(toolbar()).getByRole('button', { name: /Срок/ }));
    await env.user.click(screen.getByRole('button', { name: 'Без срока' }));
    expect(toastMessages()).toContain('Срок убран у 2 задач');
    await waitFor(() => expect([saved('a').dueDate, saved('c').dueDate]).toEqual([null, null]));
    expect(saved('b').dueDate).toBe('2026-10-28');
  });

  it('cancelling bulk deletion leaves every task unchanged and keeps the selection', async () => {
    await start();
    await waitFor(() => expect(env.readData().tasks).toHaveLength(6));
    const before = JSON.stringify(env.readData().tasks);
    await select('Альфа', 'Эпсилон');
    await env.user.click(within(toolbar()).getByRole('button', { name: 'Удалить' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Удалить выбранные задачи?' });
    expect(dialog).toHaveTextContent('Будут удалены 2 задачи. Это действие нельзя отменить.');
    await env.user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(listRows()).toHaveLength(6);
    expect(toolbar()).toHaveTextContent('Выбраны 2 задачи');
    expect(JSON.stringify(env.readData().tasks)).toBe(before);
  });

  it('confirmed bulk deletion removes exactly the selected tasks and renumbers columns', async () => {
    await start();
    await select('Альфа', 'Эпсилон');
    await env.user.click(within(toolbar()).getByRole('button', { name: 'Удалить' }));
    await env.user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить (2)' }));
    expect(toastMessages()).toContain('Удалены 2 задачи');
    expect(toolbar()).not.toBeInTheDocument();
    expect(listRows().map((row) => row.title)).toEqual(['Бета', 'Гамма', 'Дельта', 'Зета']);
    await waitFor(() => expect(env.readData().tasks).toHaveLength(4));
    expect(savedColumn('todo')).toEqual(['b:0', 'c:1']);
    expect(savedColumn('inProgress')).toEqual(['d:0']);
  });

  it('persists bulk changes across a restart', async () => {
    await start();
    await select('Бета', 'Гамма');
    await env.user.selectOptions(within(toolbar()).getByRole('combobox', { name: 'Изменить статус выбранных задач' }), 'Готово');
    await waitFor(() => expect(saved('b').status).toBe('done'));
    env.unmount();
    env = await renderApp({ temp: env.temp });
    expect(listRows().filter((row) => row.status === 'done').map((row) => row.title)).toEqual(['Зета', 'Бета', 'Гамма']);
    expect(toolbar()).not.toBeInTheDocument();
  });
});

describe('List View regressions and localization', () => {
  it('title click still opens the editor and the row status select still works', async () => {
    await start();
    await env.user.click(screen.getByRole('button', { name: 'Гамма' }));
    expect(screen.getByRole('dialog', { name: 'Редактирование задачи' })).toBeInTheDocument();
    await env.user.click(screen.getByRole('button', { name: 'Отмена' }));
    await env.user.selectOptions(screen.getByRole('combobox', { name: 'Статус задачи «Гамма»' }), 'Готово');
    await waitFor(() => expect(saved('c').status).toBe('done'));
    expect(toolbar()).not.toBeInTheDocument();
  });

  it('works in English', async () => {
    await start();
    await env.user.click(screen.getByRole('radio', { name: 'EN' }));
    await env.user.click(screen.getByRole('checkbox', { name: 'Select task “Альфа”' }));
    await env.user.click(screen.getByRole('checkbox', { name: 'Select task “Бета”' }));
    const bar = screen.getByRole('toolbar', { name: 'Actions for selected tasks' });
    expect(bar).toHaveTextContent('2 tasks selected');
    expect(within(bar).getByRole('combobox', { name: 'Change status of selected tasks' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Clear selection' })).toBeInTheDocument();
    await env.user.click(within(bar).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete selected tasks?' });
    expect(dialog).toHaveTextContent('2 tasks will be permanently deleted.');
    await env.user.click(within(dialog).getByRole('button', { name: 'Delete (2)' }));
    expect(toastMessages()).toContain('2 tasks deleted');
    expect(screen.getByRole('checkbox', { name: 'Select all visible tasks' })).toBeInTheDocument();
  });

  it('every bulk control has an accessible name', async () => {
    await start();
    await select('Альфа');
    for (const control of [...within(toolbar()).getAllByRole('button'), ...within(toolbar()).getAllByRole('combobox')]) {
      expect(control).toHaveAccessibleName();
    }
    for (const box of screen.getAllByRole('checkbox')) expect(box).toHaveAccessibleName();
  });
});
