// Category management, assignment and sidebar navigation through the real UI.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXED_TODAY, makeCategory, makeDocument, makeTask } from '../helpers/fixtures.js';
import { allCardTitles, card, heading, navButton, statsText, toastMessages } from '../helpers/queries.js';
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

const createCategory = async (user, name) => {
  await user.click(screen.getByRole('button', { name: 'Добавить категорию' }));
  const dialog = screen.getByRole('dialog', { name: 'Новая категория' });
  await user.type(within(dialog).getByRole('textbox', { name: 'Название' }), `${name}{Enter}`);
  return dialog;
};

const seeded = () =>
  makeDocument({
    categories: [makeCategory({ id: 'work', name: 'Работа', order: 0 }), makeCategory({ id: 'home', name: 'Дом', order: 1 })],
    tasks: [
      makeTask({ id: 'w1', title: 'Отчёт', categoryId: 'work', order: 0 }),
      makeTask({ id: 'w2', title: 'Совещание', categoryId: 'work', status: 'done', order: 0 }),
      makeTask({ id: 'h1', title: 'Уборка', categoryId: 'home', order: 1 }),
      makeTask({ id: 'n1', title: 'Без папки', order: 2 }),
    ],
  });

describe('creating and renaming categories', () => {
  it('creates a category with a toast and saves it with a stable id', async () => {
    env = await renderApp();
    await createCategory(env.user, 'Работа');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(navButton('Работа')).toHaveAccessibleName('Работа, 0 задач');
    expect(toastMessages()).toContain('Категория «Работа» создана');
    await waitFor(() => expect(env.readData().categories).toEqual([expect.objectContaining({ name: 'Работа', order: 0, id: expect.stringMatching(/^cat-/) })]));
  });

  it('rejects empty and duplicate names with localized errors', async () => {
    env = await renderApp({ document: seeded() });
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Добавить категорию' }));
    const dialog = screen.getByRole('dialog', { name: 'Новая категория' });
    await user.click(within(dialog).getByRole('button', { name: 'Создать' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Введите название категории.');
    await user.type(within(dialog).getByRole('textbox', { name: 'Название' }), '  работа ');
    await user.click(within(dialog).getByRole('button', { name: 'Создать' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Категория с таким названием уже есть.');
    await user.keyboard('{Escape}');
    expect(env.readData().categories).toHaveLength(2);
  });

  it('renames from the sidebar and keeps the id', async () => {
    env = await renderApp({ document: seeded() });
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Переименовать категорию «Дом»' }));
    const dialog = screen.getByRole('dialog', { name: 'Переименовать категорию' });
    const input = within(dialog).getByRole('textbox', { name: 'Название' });
    expect(input).toHaveValue('Дом');
    await user.clear(input);
    await user.type(input, 'Личное{Enter}');
    expect(navButton('Личное')).toBeInTheDocument();
    await waitFor(() => expect(env.readData().categories.find((category) => category.id === 'home').name).toBe('Личное'));
  });

  it('renames from the header of the selected category', async () => {
    env = await renderApp({ document: seeded() });
    const { user } = env;
    await user.click(navButton('Работа'));
    await user.click(within(screen.getByRole('heading', { level: 1 }).closest('header')).getByRole('button', { name: 'Переименовать категорию «Работа»' }));
    const input = within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Название' });
    await user.clear(input);
    await user.type(input, 'Офис{Enter}');
    expect(heading()).toBe('Офис');
  });
});

describe('navigation and assignment', () => {
  it('All tasks includes uncategorized tasks; categories and Uncategorized are scoped', async () => {
    env = await renderApp({ document: seeded() });
    const { user } = env;
    expect(heading()).toBe('Все задачи');
    expect(allCardTitles().sort()).toEqual(['Без папки', 'Отчёт', 'Совещание', 'Уборка'].sort());
    expect(navButton('Все задачи')).toHaveAttribute('aria-current', 'page');

    await user.click(navButton('Работа'));
    expect(heading()).toBe('Работа');
    expect(allCardTitles().sort()).toEqual(['Отчёт', 'Совещание']);
    expect(navButton('Работа')).toHaveAttribute('aria-current', 'page');
    expect(statsText()).toMatch(/2\s*Всего\s*1\s*Выполнено/);

    await user.click(navButton('Без категории'));
    expect(allCardTitles()).toEqual(['Без папки']);
  });

  it('shows per-destination counts', async () => {
    env = await renderApp({ document: seeded() });
    expect(navButton('Все задачи')).toHaveAccessibleName('Все задачи, 4 задачи');
    expect(navButton('Работа')).toHaveAccessibleName('Работа, 2 задачи');
    expect(navButton('Дом')).toHaveAccessibleName('Дом, 1 задача');
    expect(navButton('Без категории')).toHaveAccessibleName('Без категории, 1 задача');
  });

  it('assigns a category in the task dialog; new tasks default to the selected category', async () => {
    env = await renderApp({ document: seeded() });
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Без папки' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Категория' }), 'Дом');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(navButton('Дом')).toHaveAccessibleName('Дом, 2 задачи');

    await user.click(navButton('Работа'));
    await user.click(screen.getByRole('button', { name: 'Новая задача' }));
    const select = screen.getByRole('combobox', { name: 'Категория' });
    expect(select.selectedOptions[0]).toHaveTextContent('Работа');
    await user.type(screen.getByRole('textbox', { name: /Название/ }), 'Новая в работе{Enter}');
    expect(allCardTitles()).toContain('Новая в работе');
    await waitFor(() => expect(env.readData().tasks.find((task) => task.title === 'Новая в работе').categoryId).toBe('work'));
  });

  it('shows category tags on cards only in All tasks and only for categorized tasks', async () => {
    env = await renderApp({ document: seeded() });
    expect(card('Отчёт')).toHaveTextContent('Работа');
    expect(card('Без папки')).not.toHaveTextContent('Без категории');
    await env.user.click(navButton('Работа'));
    expect(card('Отчёт')).not.toHaveTextContent('Работа');
  });
});

describe('deleting categories', () => {
  it('cancel keeps the category', async () => {
    env = await renderApp({ document: seeded() });
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Удалить категорию «Работа»' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Удалить категорию «Работа»?' });
    expect(dialog).toHaveTextContent('В категории 2 задачи. Они не будут удалены');
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(navButton('Работа')).toBeInTheDocument();
  });

  it('moves tasks to another category, never deletes them, and leaves the deleted view', async () => {
    env = await renderApp({ document: seeded() });
    const { user } = env;
    await user.click(navButton('Работа'));
    await user.click(within(screen.getByRole('heading', { level: 1 }).closest('header')).getByRole('button', { name: 'Удалить категорию «Работа»' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('radio', { name: /Перенести в категорию/ }));
    expect(within(dialog).getByRole('combobox', { name: 'Категория для задач' })).toHaveValue('home');
    await user.click(within(dialog).getByRole('button', { name: 'Удалить категорию' }));

    expect(heading()).toBe('Все задачи');
    expect(screen.queryByRole('button', { name: /^Работа,/ })).not.toBeInTheDocument();
    expect(navButton('Дом')).toHaveAccessibleName('Дом, 3 задачи');
    expect(toastMessages()).toContain('Категория «Работа» удалена, 2 задачи перенесены в «Дом»');
    await waitFor(() => {
      const data = env.readData();
      expect(data.tasks).toHaveLength(4);
      expect(data.categories.map((category) => category.id)).toEqual(['home']);
      expect(data.tasks.filter((task) => task.categoryId === 'home')).toHaveLength(3);
    });
  });

  it('moves tasks to Uncategorized by default', async () => {
    env = await renderApp({ document: seeded() });
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Удалить категорию «Дом»' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить категорию' }));
    expect(navButton('Без категории')).toHaveAccessibleName('Без категории, 2 задачи');
    expect(allCardTitles()).toContain('Уборка');
    await waitFor(() => expect(env.readData().tasks.find((task) => task.id === 'h1').categoryId).toBeNull());
  });

  it('deletes an empty category with a simple message', async () => {
    env = await renderApp();
    const { user } = env;
    await createCategory(user, 'Пустая');
    await user.click(screen.getByRole('button', { name: 'Удалить категорию «Пустая»' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('В этой категории нет задач.');
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Удалить категорию' }));
    expect(screen.queryByRole('button', { name: /^Пустая,/ })).not.toBeInTheDocument();
  });
});

describe('remembered view and restart', () => {
  it('restores the selected category and List view after a restart', async () => {
    env = await renderApp({ document: seeded() });
    const { user } = env;
    await user.click(navButton('Работа'));
    await user.click(screen.getByRole('button', { name: 'Список' }));
    await waitFor(() => expect(env.readData().settings.lastView).toEqual({ destination: 'work', layout: 'list' }));
    env.unmount();

    env = await renderApp({ temp: env.temp });
    expect(heading()).toBe('Работа');
    expect(screen.getByRole('table', { name: 'Список задач' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Список' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('falls back to All tasks and Board when the remembered category no longer exists', async () => {
    const document = seeded();
    document.settings.lastView = { destination: 'deleted', layout: 'list' };
    env = await renderApp({ document });
    expect(heading()).toBe('Все задачи');
    expect(screen.getByRole('button', { name: 'Список' })).toHaveAttribute('aria-pressed', 'true');
    // An invalid remembered view is not a data problem: no storage warning is shown.
    expect(screen.queryByText(/Не удалось|повреждён|исправлена/)).not.toBeInTheDocument();
  });

  it('treats a task pointing to an unknown category as uncategorized', async () => {
    env = await renderApp({ document: makeDocument({ tasks: [makeTask({ title: 'Сирота', categoryId: 'ghost' })] }) });
    expect(navButton('Без категории')).toHaveAccessibleName('Без категории, 1 задача');
  });
});
