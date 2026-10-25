// Regression: dragging a card to another column only worked in Manual order. jsdom has no layout,
// so dnd-kit's own collision detection cannot run; the Board's drag handlers are driven directly
// with the events dnd-kit would send (start, over another column, drop).
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXED_TODAY, makeDocument, makeTask } from '../helpers/fixtures.js';
import { cardTitles } from '../helpers/queries.js';
import { renderApp } from '../helpers/renderApp.jsx';

const dnd = vi.hoisted(() => ({ props: null }));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal();
  const { createElement } = await import('react');
  return {
    ...actual,
    DndContext: (props) => {
      dnd.props = props;
      return createElement(actual.DndContext, props);
    },
  };
});

let env;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_TODAY);
});
afterEach(() => {
  vi.useRealTimers();
  env?.temp.remove();
});

const RECT = { top: 0, left: 0, width: 100, height: 40 };
const drag = async (taskId, overId) => {
  const active = { id: taskId, rect: { current: { translated: RECT } } };
  const over = { id: overId, rect: RECT };
  await act(async () => dnd.props.onDragStart({ active }));
  await act(async () => dnd.props.onDragOver({ active, over }));
  await act(async () => dnd.props.onDragEnd({ active, over }));
};
const sortBy = (label) => env.user.selectOptions(screen.getByRole('combobox', { name: /Сортировка/ }), label);
const saved = (id) => env.readData().tasks.find((task) => task.id === id);

const seed = () =>
  makeDocument({
    tasks: [
      makeTask({ id: 'b', title: 'Бета', dueDate: '2026-10-25', priority: 'low', order: 0 }),
      makeTask({ id: 'a', title: 'Альфа', dueDate: '2026-10-28', priority: 'medium', order: 1 }),
      makeTask({ id: 'w1', title: 'Яблоко', status: 'inProgress', dueDate: '2026-10-30', priority: 'low', order: 0 }),
      makeTask({ id: 'w2', title: 'Вишня', status: 'inProgress', dueDate: '2026-10-22', priority: 'high', order: 1 }),
    ],
  });

describe('moving cards between columns with every sort', () => {
  it.each([
    ['По сроку', 'a', ['Вишня', 'Альфа', 'Яблоко']],
    ['По приоритету', 'a', ['Вишня', 'Альфа', 'Яблоко']],
    ['По названию', 'b', ['Бета', 'Вишня', 'Яблоко']],
  ])('%s: the status changes and the card appears in the new column where the sort puts it', async (label, id, expected) => {
    env = await renderApp({ document: seed() });
    await sortBy(label);
    await drag(id, 'column:inProgress');
    await waitFor(() => expect(saved(id).status).toBe('inProgress'));
    expect(cardTitles('В работе')).toEqual(expected);
    expect(cardTitles('К выполнению')).not.toContain(saved(id).title);
    // The moved task joins the end of the column's manual order; the others keep theirs.
    expect([saved('w1').order, saved('w2').order]).toEqual([0, 1]);
    expect(saved(id).order).toBe(2);
  });

  it('dropping on a card in another column of a sorted view changes only the status', async () => {
    env = await renderApp({ document: seed() });
    await sortBy('По сроку');
    await drag('b', 'w1');
    await waitFor(() => expect(saved('b').status).toBe('inProgress'));
    expect(cardTitles('В работе')).toEqual(['Вишня', 'Бета', 'Яблоко']);
  });

  it('dropping back in the same column of a sorted view changes nothing', async () => {
    env = await renderApp({ document: seed() });
    await sortBy('По названию');
    const before = JSON.stringify(env.readData().tasks);
    await drag('a', 'b');
    expect(JSON.stringify(env.readData().tasks)).toBe(before);
  });

  it('Manual order still places the card at the drop position', async () => {
    env = await renderApp({ document: seed() });
    await drag('a', 'w1');
    await waitFor(() => expect(saved('a').status).toBe('inProgress'));
    // Unchanged behavior: the card takes the slot of the card it is dropped on.
    expect(cardTitles('В работе')).toEqual(['Яблоко', 'Альфа', 'Вишня']);
    expect(env.readData().tasks.filter((task) => task.status === 'inProgress').sort((x, y) => x.order - y.order).map((task) => task.id)).toEqual(['w1', 'a', 'w2']);
  });
});
