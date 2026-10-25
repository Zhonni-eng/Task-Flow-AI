// Creating, editing, validating and deleting tasks through the real UI.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXED_TODAY } from '../helpers/fixtures.js';
import { card, cardTitles, toastMessages } from '../helpers/queries.js';
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

const openNewTask = async (user) => {
  await user.click(screen.getByRole('button', { name: 'Новая задача' }));
  return screen.getByRole('dialog', { name: 'Новая задача' });
};

describe('task creation', () => {
  it('shows a validation error for an empty or blank title and creates nothing', async () => {
    env = await renderApp();
    const { user } = env;
    const dialog = await openNewTask(user);
    await user.click(within(dialog).getByRole('button', { name: 'Создать задачу' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Введите название задачи.');
    const title = within(dialog).getByRole('textbox', { name: /Название/ });
    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(title).toHaveFocus();

    await user.type(title, '   ');
    await user.click(within(dialog).getByRole('button', { name: 'Создать задачу' }));
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(8);
  });

  it('creates a task with all fields at the top of To Do and saves it', async () => {
    env = await renderApp();
    const { user } = env;
    const dialog = await openNewTask(user);
    await user.type(within(dialog).getByRole('textbox', { name: /Название/ }), 'Подготовить отчёт');
    await user.type(within(dialog).getByRole('textbox', { name: /Описание/ }), 'Квартальные цифры');
    await user.click(within(dialog).getByRole('radio', { name: 'Высокий' }));
    await user.type(within(dialog).getByRole('textbox', { name: /Метки/ }), 'Финансы{Enter}Срочно,');
    await user.click(within(dialog).getByRole('button', { name: /Срок/ }));
    await user.click(within(dialog).getByRole('button', { name: /25 октября 2026/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Создать задачу' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(cardTitles('К выполнению')[0]).toBe('Подготовить отчёт');
    const created = card('Подготовить отчёт');
    expect(created).toHaveTextContent('Высокий');
    expect(created).toHaveTextContent('Квартальные цифры');
    expect(within(created).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Финансы', 'Срочно']);
    expect(toastMessages()).toContain('Задача «Подготовить отчёт» создана');

    await waitFor(() => {
      const saved = env.readData().tasks.find((task) => task.title === 'Подготовить отчёт');
      expect(saved).toMatchObject({ priority: 'high', dueDate: '2026-10-25', labels: ['Финансы', 'Срочно'], status: 'todo', order: 0 });
    });
  });

  it('keeps a label that was typed but not yet confirmed', async () => {
    env = await renderApp();
    const { user } = env;
    const dialog = await openNewTask(user);
    await user.type(within(dialog).getByRole('textbox', { name: /Название/ }), 'С меткой');
    await user.type(within(dialog).getByRole('textbox', { name: /Метки/ }), 'Черновая');
    await user.click(within(dialog).getByRole('button', { name: 'Создать задачу' }));
    expect(within(card('С меткой')).getByRole('listitem')).toHaveTextContent('Черновая');
  });
});

describe('task editing', () => {
  it('opens prefilled, saves in place without duplicates', async () => {
    env = await renderApp();
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Подготовить план спринта' }));
    const dialog = screen.getByRole('dialog', { name: 'Редактирование задачи' });
    const title = within(dialog).getByRole('textbox', { name: /Название/ });
    expect(title).toHaveValue('Подготовить план спринта');
    expect(within(dialog).getByRole('radio', { name: 'Высокий' })).toBeChecked();

    await user.clear(title);
    await user.type(title, 'План спринта v2');
    await user.click(within(dialog).getByRole('radio', { name: 'Низкий' }));
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    expect(screen.getAllByRole('article')).toHaveLength(8);
    expect(cardTitles('К выполнению')[0]).toBe('План спринта v2');
    expect(card('План спринта v2')).toHaveTextContent('Низкий');
    await waitFor(() => expect(env.readData().tasks.find((task) => task.id === 'sample-t1')).toMatchObject({ title: 'План спринта v2', priority: 'low' }));
  });

  it('cancel leaves the task unchanged', async () => {
    env = await renderApp();
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Подготовить план спринта' }));
    const dialog = screen.getByRole('dialog', { name: 'Редактирование задачи' });
    await user.type(within(dialog).getByRole('textbox', { name: /Название/ }), ' изменено');
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(screen.getByRole('heading', { level: 3, name: 'Подготовить план спринта' })).toBeInTheDocument();
  });

  it('blocks saving with an empty title', async () => {
    env = await renderApp();
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Подготовить план спринта' }));
    const dialog = screen.getByRole('dialog', { name: 'Редактирование задачи' });
    await user.clear(within(dialog).getByRole('textbox', { name: /Название/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Введите название задачи.');
  });
});

describe('unsaved-edit confirmation', () => {
  it('Escape on an edited form asks first; "keep editing" keeps the text', async () => {
    env = await renderApp();
    const { user } = env;
    const dialog = await openNewTask(user);
    await user.type(within(dialog).getByRole('textbox', { name: /Название/ }), 'Черновик');
    await user.keyboard('{Escape}');
    const confirm = screen.getByRole('alertdialog', { name: 'Закрыть без сохранения?' });
    await user.click(within(confirm).getByRole('button', { name: 'Продолжить редактирование' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: /Название/ })).toHaveValue('Черновик');
  });

  it('backdrop click on an edited form asks first; confirming discards', async () => {
    env = await renderApp();
    const { user } = env;
    const dialog = await openNewTask(user);
    await user.type(within(dialog).getByRole('textbox', { name: /Название/ }), 'Черновик');
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    const confirm = screen.getByRole('alertdialog', { name: 'Закрыть без сохранения?' });
    await user.click(within(confirm).getByRole('button', { name: 'Закрыть без сохранения' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: 'Черновик' })).not.toBeInTheDocument();
  });

  it('closes an unchanged form directly on Escape', async () => {
    env = await renderApp();
    const { user } = env;
    await openNewTask(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('Escape inside the open calendar closes only the calendar', async () => {
    env = await renderApp();
    const { user } = env;
    const dialog = await openNewTask(user);
    await user.click(within(dialog).getByRole('button', { name: /Срок/ }));
    expect(within(dialog).getByRole('grid')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(within(dialog).queryByRole('grid')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Новая задача' })).toBeInTheDocument();
  });
});

describe('task deletion', () => {
  it('asks for confirmation; cancel keeps the task', async () => {
    env = await renderApp();
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Удалить задачу «Собрать отзывы пользователей»' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Удалить задачу?' });
    expect(confirm).toHaveTextContent('Задача «Собрать отзывы пользователей» будет удалена');
    await user.click(within(confirm).getByRole('button', { name: 'Отмена' }));
    expect(screen.getByRole('heading', { level: 3, name: 'Собрать отзывы пользователей' })).toBeInTheDocument();
  });

  it('confirmed delete removes the task, renumbers the column, saves and notifies', async () => {
    env = await renderApp();
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Удалить задачу «Подготовить план спринта»' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить' }));
    expect(cardTitles('К выполнению')).toEqual(['Обновить руководство для новичков', 'Собрать отзывы пользователей']);
    expect(toastMessages()).toContain('Задача «Подготовить план спринта» удалена');
    await waitFor(() => {
      const todo = env.readData().tasks.filter((task) => task.status === 'todo');
      expect(todo.map((task) => task.order).sort()).toEqual([0, 1]);
      expect(env.readData().tasks).toHaveLength(7);
    });
  });

  it('can delete from inside the edit dialog (confirmation stacks on top)', async () => {
    env = await renderApp();
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Утвердить цветовую палитру' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Редактирование задачи' })).getByRole('button', { name: 'Удалить' }));
    expect(screen.getByRole('alertdialog', { name: 'Удалить задачу?' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(cardTitles('Готово')).toEqual(['Настроить автоматическую сборку']);
  });
});
