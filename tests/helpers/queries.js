// Accessible queries shared by component tests (role/name based, like a user or screen reader).
import { screen, within } from '@testing-library/react';

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const column = (name) => screen.getByRole('region', { name });

/** Task titles in a Board column, top to bottom. */
export const cardTitles = (columnName) =>
  within(column(columnName))
    .queryAllByRole('heading', { level: 3 })
    .map((heading) => heading.textContent);

export const allCardTitles = () => screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);

export const card = (title) => screen.getByRole('heading', { level: 3, name: title }).closest('article');

/** Sidebar destination button ("Работа, 2 задачи"). */
export const navButton = (name) => screen.getByRole('button', { name: new RegExp(`^${escapeRegExp(name)},`) });

export const statsText = () => screen.getByRole('region', { name: /Статистика задач|Task statistics/ }).textContent;

export const heading = () => screen.getByRole('heading', { level: 1 }).textContent;

/** List View rows as { title, status, selected } (header row excluded). */
export const listRows = () =>
  screen
    .getAllByRole('row')
    .filter((row) => within(row).queryAllByRole('cell').length > 1)
    .map((row) => ({
      // Cell 0 is the selection checkbox, cell 1 the title.
      title: within(row).getAllByRole('cell')[1].querySelector('button').textContent,
      status: within(row).getByRole('combobox').value,
      selected: within(row).getByRole('checkbox').checked,
    }))
    .map(({ selected, ...row }) => (selected ? { ...row, selected } : row));

export const toastMessages = () =>
  within(screen.getByRole('status', { name: /Уведомления|Notifications/ }))
    .queryAllByRole('paragraph')
    .map((node) => node.textContent);
