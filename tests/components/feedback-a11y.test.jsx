// Notifications, storage notices, error fallback, keyboard use and accessible names.
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXED_TODAY, makeDocument, makeTask } from '../helpers/fixtures.js';
import { toastMessages } from '../helpers/queries.js';
import { renderApp } from '../helpers/renderApp.jsx';

let env;
afterEach(() => {
  vi.useRealTimers();
  env?.temp.remove();
  env = undefined;
});

describe('confirmation notifications', () => {
  it('auto-dismiss after 4 seconds, keep at most 3, and can be closed', async () => {
    vi.useFakeTimers();
    const { useToasts } = await import('../../src/state/useToasts.js');
    const { result } = renderHook(() => useToasts());
    act(() => {
      result.current.notify('one');
      result.current.notify('two');
      result.current.notify('three');
      result.current.notify('four');
    });
    expect(result.current.toasts.map((toast) => toast.message)).toEqual(['two', 'three', 'four']);
    act(() => result.current.dismiss(result.current.toasts[0].id));
    expect(result.current.toasts.map((toast) => toast.message)).toEqual(['three', 'four']);
    act(() => vi.advanceTimersByTime(3999));
    expect(result.current.toasts).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.toasts).toHaveLength(0);
  });

  it('render in a polite live region with a labelled close button', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_TODAY);
    env = await renderApp();
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Новая задача' }));
    await user.type(screen.getByRole('textbox', { name: /Название/ }), 'Уведомление{Enter}');
    const region = screen.getByRole('status', { name: 'Уведомления' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(toastMessages()).toEqual(['Задача «Уведомление» создана']);
    await user.click(within(region).getByRole('button', { name: 'Закрыть уведомление' }));
    expect(toastMessages()).toEqual([]);
  });
});

describe('storage notices', () => {
  it('a failed save shows a localized error with Retry; retry saves and clears it', async () => {
    env = await renderApp({ document: makeDocument({ tasks: [makeTask({ title: 'Есть' })] }) });
    const { user } = env;
    env.failNextSaves(1);
    await user.click(screen.getByRole('button', { name: 'Новая задача' }));
    await user.type(screen.getByRole('textbox', { name: /Название/ }), 'Во время сбоя{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось сохранить изменения.');
    expect(screen.getByRole('heading', { level: 3, name: 'Во время сбоя' })).toBeInTheDocument();
    expect(env.readData().tasks.map((task) => task.title)).toEqual(['Есть']);

    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(screen.queryByText('Не удалось сохранить изменения.')).not.toBeInTheDocument());
    expect(env.readData().tasks.map((task) => task.title).sort()).toEqual(['Во время сбоя', 'Есть']);
  });

  it('reports recovery from a backup and names the preserved copy', async () => {
    const { createBridge } = await import('../helpers/renderApp.jsx');
    const prepared = createBridge({ document: makeDocument({ tasks: [makeTask({ title: 'Из копии' })] }) });
    // Make the current file the backup, then corrupt the current file.
    const fs = await import('node:fs');
    fs.copyFileSync(prepared.temp.file('taskflow-data.json'), prepared.temp.file('taskflow-data.json.bak'));
    prepared.temp.writeText('taskflow-data.json', '{ broken');
    env = await renderApp({ temp: prepared.temp });
    expect(screen.getByText('Файл с задачами был повреждён. Восстановлена последняя сохранённая копия.')).toBeInTheDocument();
    expect(screen.getByText(/Исходный файл сохранён как taskflow-data\.unreadable-/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Из копии' })).toBeInTheDocument();
    await env.user.click(screen.getByRole('button', { name: 'Скрыть' }));
    expect(screen.queryByText(/повреждён/)).not.toBeInTheDocument();
  });

  it('opens newer data read-only with a persistent notice and never writes', async () => {
    const future = { schemaVersion: 9, settings: { language: 'ru' }, tasks: [] };
    env = await renderApp({ document: future });
    const { user } = env;
    expect(screen.getByText(/более новой версией Taskflow/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Скрыть' })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('heading', { level: 1 }).closest('header')).getByRole('button', { name: 'Новая задача' }));
    await user.type(screen.getByRole('textbox', { name: /Название/ }), 'Не сохранится{Enter}');
    expect(env.readData()).toEqual(future);
  });
});

describe('error fallback', () => {
  it('shows a localized fallback and reloads only after pending saves finish', async () => {
    let releaseSave;
    window.taskflow = {
      storage: {
        load: async () => ({ status: 'loaded', writable: true, settings: { language: 'ru' }, tasks: [], categories: [] }),
        saveBoard: () => new Promise((resolve) => { releaseSave = () => resolve({ ok: true }); }),
        saveSettings: async () => ({ ok: true }),
        onBeforeClose: () => {},
      },
    };
    vi.resetModules();
    const storage = await import('../../src/storage/storage.js');
    const { default: ErrorBoundary } = await import('../../src/components/ErrorBoundary.jsx');
    const { I18nProvider } = await import('../../src/i18n/I18nProvider.jsx');
    await storage.loadAppData();
    storage.saveBoard({ tasks: [], categories: [] }); // a save still in flight

    const reload = vi.fn();
    const Broken = () => {
      throw new Error('boom');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <I18nProvider initialLanguage="ru">
        <ErrorBoundary reload={reload}>
          <Broken />
        </ErrorBoundary>
      </I18nProvider>,
    );
    const fallback = screen.getByRole('alert');
    expect(fallback).toHaveTextContent('Что-то пошло не так');
    expect(fallback).toHaveTextContent('Сохранённые задачи не пострадали');
    const button = within(fallback).getByRole('button', { name: 'Перезагрузить' });
    expect(button).toHaveFocus();

    await user.click(button);
    expect(reload).not.toHaveBeenCalled();
    await act(async () => releaseSave());
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});

describe('keyboard and accessible names', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_TODAY);
  });

  const expectAllNamed = (container = document.body) => {
    const controls = within(container).queryAllByRole('button').concat(within(container).queryAllByRole('combobox'), within(container).queryAllByRole('textbox'), within(container).queryAllByRole('searchbox'));
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control).toHaveAccessibleName();
  };

  it('every control is named in Board view, List view, filter menu and dialogs', async () => {
    env = await renderApp();
    const { user } = env;
    expectAllNamed();
    await user.click(screen.getByRole('button', { name: 'Список' }));
    expectAllNamed();
    await user.click(screen.getByRole('button', { name: /^Фильтры/ }));
    expectAllNamed();
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toHaveAccessibleName();
    await user.click(screen.getByRole('button', { name: 'Новая задача' }));
    await user.click(screen.getByRole('button', { name: /Срок/ }));
    expectAllNamed(screen.getByRole('dialog', { name: 'Новая задача' }));
  });

  it('the icon-only view switcher is named, has a tooltip and exposes its pressed state', async () => {
    env = await renderApp();
    const board = screen.getByRole('button', { name: 'Доска' });
    const list = screen.getByRole('button', { name: 'Список' });
    expect(board).toHaveAttribute('aria-pressed', 'true');
    expect(board).toHaveAttribute('title', 'Доска');
    expect(list).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('group', { name: 'Вид' })).toContainElement(list);
    await env.user.click(list);
    expect(list).toHaveAttribute('aria-pressed', 'true');
  });

  it('Tab reaches navigation, toolbar, task cards, drag handles and header actions', async () => {
    env = await renderApp();
    const { user } = env;
    const reached = new Set();
    for (let i = 0; i < 60; i += 1) {
      await user.tab();
      const element = document.activeElement;
      reached.add(element.getAttribute('aria-label') ?? element.getAttribute('placeholder') ?? element.textContent.trim());
    }
    const has = (pattern) => [...reached].some((name) => pattern.test(name));
    expect(has(/^Все задачи,/)).toBe(true);
    expect(has(/^Добавить категорию$/)).toBe(true);
    expect(has(/^Доска$/)).toBe(true);
    expect(has(/^Поиск по названию/)).toBe(true);
    expect(has(/^Фильтры/)).toBe(true);
    expect(has(/^Переместить задачу/)).toBe(true);
    expect(has(/^Подготовить план спринта$/)).toBe(true);
    expect(has(/Новая задача/)).toBe(true);
  });

  it('calendar supports arrow keys and PageDown, and Enter picks the date', async () => {
    env = await renderApp();
    const { user } = env;
    await user.click(screen.getByRole('button', { name: 'Новая задача' }));
    const trigger = screen.getByRole('button', { name: /Срок/ });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toHaveAttribute('data-date', '2026-10-21');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toHaveAttribute('data-date', '2026-10-22');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toHaveAttribute('data-date', '2026-10-29');
    await user.keyboard('{PageDown}');
    expect(document.activeElement).toHaveAttribute('data-date', '2026-11-29');
    await user.keyboard('{Enter}');
    expect(trigger).toHaveTextContent('29 ноября 2026');
    expect(trigger).toHaveFocus();
  });

  it('the filter menu closes with Escape and when focus moves elsewhere', async () => {
    env = await renderApp();
    const { user } = env;
    const button = screen.getByRole('button', { name: /^Фильтры/ });
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
    await user.click(button);
    screen.getAllByRole('checkbox')[0].focus();
    screen.getByRole('searchbox').focus();
    await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
  });

  it('Ctrl+F focuses search and Escape clears it', async () => {
    env = await renderApp();
    const { user } = env;
    await user.keyboard('{Control>}f{/Control}');
    const box = screen.getByRole('searchbox');
    expect(box).toHaveFocus();
    await user.type(box, 'abc');
    await user.keyboard('{Escape}');
    expect(box).toHaveValue('');
  });
});

describe('localization', () => {
  it('switches the whole interface to English without translating task content', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_TODAY);
    env = await renderApp();
    const { user } = env;
    await user.click(screen.getByRole('radio', { name: 'EN' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('All tasks');
    expect(screen.getByRole('button', { name: 'New task' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'To Do' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Подготовить план спринта' })).toBeInTheDocument();
    await waitFor(() => expect(env.readData().settings.language).toBe('en'));

    env.unmount();
    env = await renderApp({ temp: env.temp });
    expect(screen.getByRole('button', { name: 'New task' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });
});
