// Stage 4: keyboard focus after removals, tab stops, accessible labels and reduced motion.
import { act, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReducedMotion } from '../../src/state/useReducedMotion.js';
import { FIXED_TODAY, makeCategory, makeDocument, makeTask } from '../helpers/fixtures.js';
import { card, listRows } from '../helpers/queries.js';
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
    categories: [makeCategory({ id: 'work', name: 'Работа и очень длинное название категории', order: 0 }), makeCategory({ id: 'home', name: 'Дом', order: 1 })],
    tasks: [
      makeTask({ id: 'a', title: 'Альфа', order: 0, categoryId: 'work' }),
      makeTask({ id: 'b', title: 'Бета', order: 1 }),
      makeTask({ id: 'c', title: 'Гамма', order: 2 }),
      makeTask({ id: 'd', title: 'Дельта', status: 'inProgress', order: 0, categoryId: 'home' }),
    ],
  });
const start = async () => {
  env = await renderApp({ document: seeded() });
  return env;
};
const titleButton = (title) => screen.getByRole('button', { name: title });
const confirmIn = async (dialogName, buttonName) =>
  env.user.click(within(screen.getByRole('alertdialog', { name: dialogName })).getByRole('button', { name: buttonName }));
const toList = () => env.user.click(screen.getByRole('button', { name: 'Список' }));
const selectAll = () => screen.getByRole('checkbox', { name: 'Выбрать все видимые задачи' });
const toolbar = () => screen.getByRole('toolbar', { name: 'Действия с выбранными задачами' });

describe('focus after removing the focused control', () => {
  it('deleting a task from its card moves focus to the next task in the column', async () => {
    await start();
    await env.user.click(screen.getByRole('button', { name: 'Удалить задачу «Бета»' }));
    await confirmIn('Удалить задачу?', 'Удалить');
    expect(titleButton('Гамма')).toHaveFocus();
  });

  it('the last task in a column hands focus to the previous one', async () => {
    await start();
    await env.user.click(screen.getByRole('button', { name: 'Удалить задачу «Гамма»' }));
    await confirmIn('Удалить задачу?', 'Удалить');
    expect(titleButton('Бета')).toHaveFocus();
  });

  it('the only task in a column hands focus to "New task"', async () => {
    await start();
    await env.user.click(screen.getByRole('button', { name: 'Удалить задачу «Дельта»' }));
    await confirmIn('Удалить задачу?', 'Удалить');
    expect(screen.getByRole('button', { name: 'Новая задача' })).toHaveFocus();
  });

  it('deleting from the edit dialog also keeps focus on the board', async () => {
    await start();
    await env.user.click(titleButton('Альфа'));
    await env.user.click(within(screen.getByRole('dialog', { name: 'Редактирование задачи' })).getByRole('button', { name: 'Удалить' }));
    await confirmIn('Удалить задачу?', 'Удалить');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(titleButton('Бета')).toHaveFocus();
  });

  it('cancelling a deletion returns focus to the delete button', async () => {
    await start();
    await env.user.click(screen.getByRole('button', { name: 'Удалить задачу «Бета»' }));
    await confirmIn('Удалить задачу?', 'Отмена');
    expect(screen.getByRole('button', { name: 'Удалить задачу «Бета»' })).toHaveFocus();
  });

  it('deleting a List View row moves focus to the next row', async () => {
    await start();
    await toList();
    await env.user.click(screen.getByRole('button', { name: 'Удалить задачу «Бета»' }));
    await confirmIn('Удалить задачу?', 'Удалить');
    expect(listRows().map((row) => row.title)).toEqual(['Альфа', 'Гамма', 'Дельта']);
    expect(titleButton('Гамма')).toHaveFocus();
  });

  it('bulk actions, bulk delete and "Clear selection" keep focus in the list', async () => {
    await start();
    await toList();
    await env.user.click(screen.getByRole('checkbox', { name: 'Выбрать задачу «Альфа»' }));
    await env.user.click(within(toolbar()).getByRole('button', { name: 'Выполнено' }));
    expect(selectAll()).toHaveFocus();

    await env.user.click(screen.getByRole('checkbox', { name: 'Выбрать задачу «Бета»' }));
    await env.user.click(within(toolbar()).getByRole('button', { name: 'Снять выделение' }));
    expect(selectAll()).toHaveFocus();

    await env.user.click(screen.getByRole('checkbox', { name: 'Выбрать задачу «Гамма»' }));
    await env.user.click(within(toolbar()).getByRole('button', { name: 'Удалить' }));
    await confirmIn('Удалить выбранные задачи?', /^Удалить/);
    expect(listRows().map((row) => row.title)).not.toContain('Гамма');
    expect(selectAll()).toHaveFocus();
  });

  it('deleting the open category moves focus to "All tasks"', async () => {
    await start();
    await env.user.click(screen.getByRole('button', { name: /^Дом,/ }));
    await env.user.click(screen.getAllByRole('button', { name: 'Удалить категорию «Дом»' })[0]);
    await confirmIn('Удалить категорию «Дом»?', 'Удалить категорию');
    expect(screen.getByRole('button', { name: /^Все задачи,/ })).toHaveFocus();
  });
});

describe('tab stops and accessible labels', () => {
  it('edit icons are named and clickable but not extra Tab stops (the title opens the same editor)', async () => {
    await start();
    const edit = screen.getByRole('button', { name: 'Редактировать задачу «Альфа»' });
    expect(edit).toHaveAttribute('tabindex', '-1');
    // Card order: handle, (edit), delete, title. Shift+Tab from the title skips the edit icon.
    titleButton('Альфа').focus();
    await env.user.tab({ shift: true });
    expect(document.activeElement).toHaveAccessibleName('Удалить задачу «Альфа»');
    await env.user.tab({ shift: true });
    expect(document.activeElement).toHaveAccessibleName(/^Переместить задачу «Альфа»/);
    await env.user.click(edit);
    expect(screen.getByRole('dialog', { name: 'Редактирование задачи' })).toBeInTheDocument();
    await env.user.keyboard('{Escape}');

    await toList();
    expect(screen.getByRole('button', { name: 'Редактировать задачу «Бета»' })).toHaveAttribute('tabindex', '-1');
    // Keyboard users reach every row action through the row title and the delete button.
    const reached = new Set();
    for (let i = 0; i < 40; i += 1) {
      await env.user.tab();
      reached.add(document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent);
    }
    expect([...reached].some((name) => /^Редактировать задачу/.test(name))).toBe(false);
    expect(reached.has('Бета')).toBe(true);
    expect(reached.has('Удалить задачу «Бета»')).toBe(true);
  });

  it('the category tag shows the full name in its tooltip and labels it for screen readers', async () => {
    await start();
    const tag = card('Альфа').querySelector('.task-card__category');
    expect(tag).toHaveAttribute('title', 'Категория: Работа и очень длинное название категории');
    expect(tag).toHaveTextContent('Категория: Работа и очень длинное название категории');
    expect(tag.querySelector('.task-card__category-name')).toHaveTextContent(/^Работа и очень длинное название категории$/);
  });

  it('select-all exposes partial selection and is disabled (not focusable) in an empty category', async () => {
    env = await renderApp({
      document: makeDocument({ categories: [makeCategory({ id: 'empty', name: 'Пустая' })], tasks: [makeTask({ title: 'Альфа' }), makeTask({ title: 'Бета', order: 1 })] }),
    });
    await toList();
    await env.user.click(screen.getByRole('checkbox', { name: 'Выбрать задачу «Альфа»' }));
    expect(selectAll().indeterminate).toBe(true);
    expect(selectAll()).not.toBeChecked();
    await env.user.click(screen.getByRole('button', { name: /^Пустая,/ }));
    expect(selectAll()).toBeDisabled();
  });

  // jsdom cannot tell keyboard focus from mouse focus (:focus-visible is unreliable there), so the
  // keyboard/mouse distinction is stubbed; the real-browser behavior is checked in Electron.
  it('keyboard focus on the board scrolls the control into view; mouse focus and drags do not', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    let keyboard = true;
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (selector) {
      return selector === ':focus-visible' ? keyboard : matches.call(this, selector);
    });
    try {
      await start();
      scrollIntoView.mockClear();
      titleButton('Дельта').focus();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(titleButton('Дельта'));

      // Focus from a mouse press (not :focus-visible) must not scroll: the card would move under the pointer.
      scrollIntoView.mockClear();
      keyboard = false;
      titleButton('Альфа').focus();
      expect(scrollIntoView).not.toHaveBeenCalled();

      keyboard = true;
      document.body.classList.add('is-dragging');
      titleButton('Бета').focus();
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      document.body.classList.remove('is-dragging');
      delete Element.prototype.scrollIntoView;
    }
  });
});

describe('reduced motion', () => {
  afterEach(() => {
    delete window.matchMedia;
  });

  const mockMedia = (matches) => {
    const listeners = new Set();
    const media = { matches, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
    window.matchMedia = vi.fn(() => media);
    return { media, change: (value) => { media.matches = value; listeners.forEach((fn) => fn()); }, listeners };
  };

  it('follows the system setting and its changes', () => {
    const { change, listeners } = mockMedia(true);
    const { result, unmount } = renderHook(() => useReducedMotion());
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(result.current).toBe(true);
    act(() => change(false));
    expect(result.current).toBe(false);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it('defaults to full motion where matchMedia is unavailable', () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });
});
