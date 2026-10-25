// Optional subtasks through the real UI: editor, progress on Board/List, interaction with
// existing features, persistence and localization.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXED_TODAY, makeDocument, makeTask } from '../helpers/fixtures.js';
import { card, listRows, toastMessages } from '../helpers/queries.js';
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

const sub = (id, title, done = false) => ({ id, title, done });
const seeded = () =>
  makeDocument({
    tasks: [
      makeTask({
        id: 'exam',
        title: 'Подготовка к экзамену',
        description: 'Сессия',
        labels: ['Учёба'],
        priority: 'high',
        order: 0,
        subtasks: [sub('s1', 'Повторить лекции', true), sub('s2', 'Решить задачи'), sub('s3', 'Разобрать сложные темы')],
      }),
      makeTask({ id: 'milk', title: 'Купить молоко', order: 1 }),
      makeTask({ id: 'report', title: 'Отчёт', status: 'inProgress', order: 0 }),
    ],
  });

const openEditor = async (title) => {
  await env.user.click(screen.getByRole('button', { name: title }));
  return screen.getByRole('dialog', { name: 'Редактирование задачи' });
};
const save = (dialog) => env.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
const subtasksOf = (id) => env.readData().tasks.find((task) => task.id === id).subtasks;
const progressOf = (container) => within(container).queryByRole('img', { name: /^Подзадачи:/ });

describe('creating and managing subtasks', () => {
  it('ordinary tasks stay simple: no indicator and only an "add subtasks" button in the editor', async () => {
    env = await renderApp({ document: seeded() });
    expect(progressOf(card('Купить молоко'))).toBeNull();
    const dialog = await openEditor('Купить молоко');
    expect(within(dialog).getByRole('button', { name: 'Добавить подзадачи' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: 'Новая подзадача' })).not.toBeInTheDocument();
  });

  it('adds subtasks to a new task with Enter (without submitting) and saves them with stable ids', async () => {
    env = await renderApp({ document: seeded() });
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Новая задача' }));
    const dialog = screen.getByRole('dialog', { name: 'Новая задача' });
    await user.type(within(dialog).getByRole('textbox', { name: /Название/ }), 'Переезд');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить подзадачи' }));
    const input = within(dialog).getByRole('textbox', { name: 'Новая подзадача' });
    expect(input).toHaveFocus();
    await user.type(input, '  Упаковать   книги {Enter}');
    expect(screen.getByRole('dialog', { name: 'Новая задача' })).toBeInTheDocument();
    await user.type(input, 'Заказать машину{Enter}');
    expect(within(dialog).getByRole('textbox', { name: 'Название подзадачи 1' })).toHaveValue('Упаковать книги');
    expect(within(dialog).getByLabelText('Подзадачи: выполнено 0 из 2')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Создать задачу' }));

    expect(progressOf(card('Переезд'))).toHaveAccessibleName('Подзадачи: выполнено 0 из 2');
    await waitFor(() => {
      const saved = env.readData().tasks.find((task) => task.title === 'Переезд');
      expect(saved.subtasks.map((s) => [s.title, s.done])).toEqual([['Упаковать книги', false], ['Заказать машину', false]]);
      expect(new Set(saved.subtasks.map((s) => s.id)).size).toBe(2);
      expect(saved.subtasks.every((s) => /^sub-/.test(s.id))).toBe(true);
    });
  });

  it('keeps a subtask that was typed but not yet added when saving', async () => {
    env = await renderApp({ document: seeded() });
    const dialog = await openEditor('Купить молоко');
    await env.user.click(within(dialog).getByRole('button', { name: 'Добавить подзадачи' }));
    await env.user.type(within(dialog).getByRole('textbox', { name: 'Новая подзадача' }), 'Проверить срок годности');
    await save(dialog);
    await waitFor(() => expect(subtasksOf('milk').map((s) => s.title)).toEqual(['Проверить срок годности']));
  });

  it('rejects empty and whitespace-only titles when adding', async () => {
    env = await renderApp({ document: seeded() });
    const dialog = await openEditor('Подготовка к экзамену');
    const input = within(dialog).getByRole('textbox', { name: 'Новая подзадача' });
    await env.user.type(input, '   {Enter}');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Введите название подзадачи.');
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(3);
    await env.user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Введите название подзадачи.');
  });

  it('edits a title, and blocks saving when an existing subtask title is cleared', async () => {
    env = await renderApp({ document: seeded() });
    let dialog = await openEditor('Подготовка к экзамену');
    const second = within(dialog).getByRole('textbox', { name: 'Название подзадачи 2' });
    await env.user.clear(second);
    await save(dialog);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Введите название подзадачи.');
    expect(second).toHaveAttribute('aria-invalid', 'true');
    expect(second).toHaveFocus();
    await env.user.type(second, 'Решить 20 задач');
    await save(dialog);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(subtasksOf('exam').map((s) => s.title)).toEqual(['Повторить лекции', 'Решить 20 задач', 'Разобрать сложные темы']));
    dialog = await openEditor('Подготовка к экзамену');
    expect(within(dialog).getByRole('textbox', { name: 'Название подзадачи 2' })).toHaveValue('Решить 20 задач');
  });

  it('completes and reopens subtasks; progress updates immediately and after saving', async () => {
    env = await renderApp({ document: seeded() });
    const dialog = await openEditor('Подготовка к экзамену');
    await env.user.click(within(dialog).getByRole('checkbox', { name: 'Подзадача «Решить задачи» выполнена' }));
    expect(within(dialog).getByLabelText('Подзадачи: выполнено 2 из 3')).toBeInTheDocument();
    await env.user.click(within(dialog).getByRole('checkbox', { name: 'Подзадача «Повторить лекции» выполнена' }));
    expect(within(dialog).getByLabelText('Подзадачи: выполнено 1 из 3')).toBeInTheDocument();
    await save(dialog);
    expect(progressOf(card('Подготовка к экзамену'))).toHaveAccessibleName('Подзадачи: выполнено 1 из 3');
    await waitFor(() => expect(subtasksOf('exam').map((s) => s.done)).toEqual([false, true, false]));
  });

  it('deletes a subtask (count updates at once) and keeps the other subtasks in order', async () => {
    env = await renderApp({ document: seeded() });
    const dialog = await openEditor('Подготовка к экзамену');
    await env.user.click(within(dialog).getByRole('button', { name: 'Удалить подзадачу «Решить задачи»' }));
    expect(within(dialog).getByLabelText('Подзадачи: выполнено 1 из 2')).toBeInTheDocument();
    await save(dialog);
    await waitFor(() => expect(subtasksOf('exam').map((s) => s.id)).toEqual(['s1', 's3']));
  });

  it('cancel discards subtask changes; Escape asks first when subtasks were changed', async () => {
    env = await renderApp({ document: seeded() });
    let dialog = await openEditor('Подготовка к экзамену');
    await env.user.click(within(dialog).getByRole('checkbox', { name: 'Подзадача «Решить задачи» выполнена' }));
    await env.user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog', { name: 'Закрыть без сохранения?' })).toBeInTheDocument();
    await env.user.click(screen.getByRole('button', { name: 'Закрыть без сохранения' }));
    dialog = await openEditor('Подготовка к экзамену');
    await env.user.click(within(dialog).getByRole('button', { name: 'Удалить подзадачу «Повторить лекции»' }));
    await env.user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(progressOf(card('Подготовка к экзамену'))).toHaveAccessibleName('Подзадачи: выполнено 1 из 3');
    expect(subtasksOf('exam')).toEqual(seeded().tasks[0].subtasks);
  });
});

describe('progress display', () => {
  it('Board card and List row show a compact indicator only for tasks with subtasks', async () => {
    env = await renderApp({ document: seeded() });
    expect(within(card('Подготовка к экзамену')).getByRole('img', { name: 'Подзадачи: выполнено 1 из 3' })).toHaveTextContent('1/3');
    expect(progressOf(card('Отчёт'))).toBeNull();
    await env.user.click(screen.getByRole('button', { name: 'Список' }));
    const rows = screen.getAllByRole('row').filter((row) => within(row).queryAllByRole('cell').length > 1);
    const examRow = rows.find((row) => row.textContent.includes('Подготовка к экзамену'));
    const milkRow = rows.find((row) => row.textContent.includes('Купить молоко'));
    expect(within(examRow).getByRole('img', { name: 'Подзадачи: выполнено 1 из 3' })).toHaveTextContent('1/3');
    expect(progressOf(milkRow)).toBeNull();
    expect(screen.queryAllByRole('columnheader').map((header) => header.textContent)).not.toContain('Подзадачи');
  });

  it('subtasks never appear as standalone tasks on the board, in the list, in counts or in search', async () => {
    env = await renderApp({ document: seeded() });
    expect(screen.queryByRole('heading', { level: 3, name: 'Решить задачи' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /^Все задачи,/ })).toHaveAccessibleName('Все задачи, 3 задачи');
    await env.user.click(screen.getByRole('button', { name: 'Список' }));
    expect(listRows()).toHaveLength(3);
    await env.user.type(screen.getByRole('searchbox'), 'Решить задачи');
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
  });
});

describe('completion semantics and existing features', () => {
  it('moving the parent to Done does not complete subtasks; reopening keeps them', async () => {
    env = await renderApp({ document: seeded() });
    await env.user.click(screen.getByRole('button', { name: 'Список' }));
    await env.user.selectOptions(screen.getByRole('combobox', { name: 'Статус задачи «Подготовка к экзамену»' }), 'Готово');
    await waitFor(() => expect(env.readData().tasks.find((task) => task.id === 'exam').status).toBe('done'));
    expect(subtasksOf('exam').map((s) => s.done)).toEqual([true, false, false]);
    await env.user.selectOptions(screen.getByRole('combobox', { name: 'Статус задачи «Подготовка к экзамену»' }), 'К выполнению');
    await waitFor(() => expect(env.readData().tasks.find((task) => task.id === 'exam').status).toBe('todo'));
    expect(subtasksOf('exam').map((s) => s.done)).toEqual([true, false, false]);
  });

  it('completing every subtask does not mark the parent as done', async () => {
    env = await renderApp({ document: seeded() });
    const dialog = await openEditor('Подготовка к экзамену');
    for (const box of within(dialog).getAllByRole('checkbox')) if (!box.checked) await env.user.click(box);
    await save(dialog);
    expect(progressOf(card('Подготовка к экзамену'))).toHaveAccessibleName('Подзадачи: выполнено 3 из 3');
    await waitFor(() => expect(subtasksOf('exam').every((s) => s.done)).toBe(true));
    expect(env.readData().tasks.find((task) => task.id === 'exam').status).toBe('todo');
  });

  it('Stage 1 bulk actions keep subtasks attached; bulk delete removes them with the parent', async () => {
    env = await renderApp({ document: seeded() });
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Список' }));
    await user.click(screen.getByRole('checkbox', { name: 'Выбрать задачу «Подготовка к экзамену»' }));
    await user.click(screen.getByRole('checkbox', { name: 'Выбрать задачу «Купить молоко»' }));
    // Subtask checkboxes are not part of the List View selection.
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Изменить приоритет выбранных задач' }), 'Низкий');
    await user.click(screen.getByRole('checkbox', { name: 'Выбрать задачу «Подготовка к экзамену»' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Изменить статус выбранных задач' }), 'Готово');
    await waitFor(() => expect(env.readData().tasks.find((task) => task.id === 'exam')).toMatchObject({ priority: 'low', status: 'done' }));
    expect(subtasksOf('exam')).toEqual(seeded().tasks[0].subtasks);

    await user.click(screen.getByRole('checkbox', { name: 'Выбрать задачу «Подготовка к экзамену»' }));
    await user.click(screen.getByRole('button', { name: 'Удалить' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить (1)' }));
    expect(toastMessages()).toContain('Удалена 1 задача');
    await waitFor(() => expect(env.readData().tasks.map((task) => task.id).sort()).toEqual(['milk', 'report']));
    expect(JSON.stringify(env.readData())).not.toContain('Повторить лекции');
  });

  it('deleting a parent from its card removes its subtasks and leaves other tasks untouched', async () => {
    env = await renderApp({ document: seeded() });
    const before = env.readData().tasks.filter((task) => task.id !== 'exam');
    await env.user.click(screen.getByRole('button', { name: 'Удалить задачу «Подготовка к экзамену»' }));
    await env.user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(env.readData().tasks).toHaveLength(2));
    expect(env.readData().tasks).toEqual(before.map((task) => (task.id === 'milk' ? { ...task, order: 0 } : task)));
  });

  it('editing other fields of a parent keeps its subtasks and unrelated fields', async () => {
    env = await renderApp({ document: seeded() });
    const dialog = await openEditor('Подготовка к экзамену');
    await env.user.click(within(dialog).getByRole('radio', { name: 'Низкий' }));
    await save(dialog);
    await waitFor(() => expect(env.readData().tasks.find((task) => task.id === 'exam').priority).toBe('low'));
    expect(env.readData().tasks.find((task) => task.id === 'exam')).toMatchObject({ description: 'Сессия', labels: ['Учёба'], subtasks: seeded().tasks[0].subtasks });
  });

  it('persists subtasks across a restart', async () => {
    env = await renderApp({ document: seeded() });
    const dialog = await openEditor('Купить молоко');
    await env.user.click(within(dialog).getByRole('button', { name: 'Добавить подзадачи' }));
    await env.user.type(within(dialog).getByRole('textbox', { name: 'Новая подзадача' }), 'Обезжиренное{Enter}');
    await save(dialog);
    await waitFor(() => expect(subtasksOf('milk')).toHaveLength(1));
    env.unmount();
    env = await renderApp({ temp: env.temp });
    expect(progressOf(card('Купить молоко'))).toHaveAccessibleName('Подзадачи: выполнено 0 из 1');
    expect(progressOf(card('Подготовка к экзамену'))).toHaveAccessibleName('Подзадачи: выполнено 1 из 3');
  });

  it('upgrades saved v2 data on launch without losing tasks', async () => {
    const v2 = seeded();
    v2.schemaVersion = 2;
    v2.tasks = v2.tasks.map(({ subtasks, ...task }) => task);
    env = await renderApp({ document: v2 });
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(progressOf(card('Подготовка к экзамену'))).toBeNull();
    expect(env.temp.list().some((name) => name.includes('before-migration'))).toBe(true);
  });
});

describe('localization and accessibility', () => {
  it('works in English', async () => {
    env = await renderApp({ document: seeded() });
    await env.user.click(screen.getByRole('radio', { name: 'EN' }));
    expect(within(card('Подготовка к экзамену')).getByRole('img', { name: 'Subtasks: 1 of 3 done' })).toBeInTheDocument();
    await env.user.click(screen.getByRole('button', { name: 'Подготовка к экзамену' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit task' });
    expect(within(dialog).getByRole('heading', { name: /Subtasks/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Subtask “Решить задачи” done' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete subtask “Решить задачи”' })).toBeInTheDocument();
    await env.user.type(within(dialog).getByRole('textbox', { name: 'New subtask' }), ' {Enter}');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a subtask title.');
  });

  it('every subtask control has an accessible name and is keyboard reachable', async () => {
    env = await renderApp({ document: seeded() });
    const dialog = await openEditor('Подготовка к экзамену');
    const controls = [...within(dialog).getAllByRole('checkbox'), ...within(dialog).getAllByRole('textbox'), ...within(dialog).getAllByRole('button')];
    for (const control of controls) expect(control).toHaveAccessibleName();
    const toggle = within(dialog).getByRole('checkbox', { name: 'Подзадача «Решить задачи» выполнена' });
    toggle.focus();
    await env.user.keyboard(' ');
    expect(toggle).toBeChecked();
    fireEvent.keyDown(within(dialog).getByRole('textbox', { name: 'Название подзадачи 1' }), { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Редактирование задачи' })).toBeInTheDocument();
  });
});
