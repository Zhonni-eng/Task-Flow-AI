// Due times, reminders, repeat rules and estimates through the real task dialog and cards, plus
// the app settings for reminders and planning availability. Real storage in a temp folder.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXED_TODAY, makeDocument, makeTask } from '../helpers/fixtures.js';
import { card } from '../helpers/queries.js';
import { renderApp } from '../helpers/renderApp.jsx';

let env;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_TODAY); // 21 Oct 2026, 12:00
});
afterEach(() => {
  vi.useRealTimers();
  env?.temp.remove();
});

const seeded = () =>
  makeDocument({
    tasks: [
      makeTask({ id: 'exam', title: 'Экзамен', dueDate: '2026-10-23', order: 0 }),
      makeTask({ id: 'idea', title: 'Идея без срока', order: 1 }),
    ],
  });
const openEditor = async (title) => {
  await env.user.click(screen.getByRole('button', { name: title }));
  return screen.getByRole('dialog', { name: 'Редактирование задачи' });
};
const save = (dialog) => env.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
const saved = (id) => env.readData().tasks.find((task) => task.id === id);

describe('due time, reminders, repeat and estimate', () => {
  it('sets a due time, reminders, a weekly repeat and an estimate; the card shows them', async () => {
    env = await renderApp({ document: seeded() });
    const dialog = await openEditor('Экзамен');
    fireEvent.change(within(dialog).getByLabelText(/Время срока/), { target: { value: '16:30' } });
    await env.user.click(within(dialog).getByRole('checkbox', { name: 'За 30 минут' }));
    await env.user.click(within(dialog).getByRole('checkbox', { name: 'За 1 день' }));
    await env.user.selectOptions(within(dialog).getByRole('combobox', { name: 'Повтор' }), 'Каждую неделю');
    fireEvent.change(within(dialog).getByLabelText(/Оценка, мин/), { target: { value: '90' } });
    await save(dialog);
    await waitFor(() =>
      expect(saved('exam')).toMatchObject({
        dueDate: '2026-10-23',
        dueTime: '16:30',
        reminders: [30, 1440],
        recurrence: { freq: 'weekly', interval: 1, weekdays: [5] },
        estimateMinutes: 90,
      }),
    );
    const due = card('Экзамен').querySelector('.due');
    expect(due).toHaveTextContent('23 окт., 16:30');
    expect(due).toHaveTextContent('Повторяется: Каждую неделю: Пт');
    expect(due).toHaveTextContent('Напоминания: за 30 минут, за 1 день');
  });

  it('removing the due time keeps the date and drops reminders that need a time', async () => {
    const doc = seeded();
    doc.tasks[0] = { ...doc.tasks[0], dueTime: '16:30', reminders: [30, 1440] };
    env = await renderApp({ document: doc });
    const dialog = await openEditor('Экзамен');
    fireEvent.change(within(dialog).getByLabelText(/Время срока/), { target: { value: '' } });
    await save(dialog);
    await waitFor(() => expect(saved('exam')).toMatchObject({ dueDate: '2026-10-23', dueTime: null, reminders: [1440] }));
  });

  it('without a due date the time, reminders and repeat are disabled and say why', async () => {
    env = await renderApp({ document: seeded() });
    const dialog = await openEditor('Идея без срока');
    expect(within(dialog).getByText(/Сначала укажите срок/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Время срока/)).toBeDisabled();
    expect(within(dialog).getByRole('combobox', { name: 'Повтор' })).toBeDisabled();
    for (const box of within(dialog).getAllByRole('checkbox', { name: /^За |^В день/ })) expect(box).toBeDisabled();
  });

  it('a time that has passed today makes the task overdue', async () => {
    const doc = seeded();
    doc.tasks[0] = { ...doc.tasks[0], dueDate: '2026-10-21', dueTime: '09:00' };
    env = await renderApp({ document: doc });
    expect(card('Экзамен').querySelector('.due')).toHaveAttribute('data-due-state', 'overdue');
  });
});

describe('app settings', () => {
  it('saves reminder settings and planning availability; rejects an end before the start', async () => {
    env = await renderApp({ document: seeded() });
    await env.user.click(screen.getByRole('button', { name: 'Настройки' }));
    const dialog = screen.getByRole('dialog', { name: 'Настройки' });
    await env.user.click(within(dialog).getByRole('checkbox', { name: 'Показывать напоминания на рабочем столе' }));
    fireEvent.change(within(dialog).getByLabelText('Время напоминаний для задач без времени'), { target: { value: '08:30' } });
    fireEvent.change(within(dialog).getByLabelText('С'), { target: { value: '18:00' } });
    fireEvent.change(within(dialog).getByLabelText('До'), { target: { value: '09:00' } });
    await env.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('начало должно быть раньше конца');
    fireEvent.change(within(dialog).getByLabelText('С'), { target: { value: '09:00' } });
    fireEvent.change(within(dialog).getByLabelText('До'), { target: { value: '18:00' } });
    await env.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(env.readData().settings).toMatchObject({ reminders: { enabled: false, allDayTime: '08:30' }, availability: { start: '09:00', end: '18:00' } }),
    );
  });
});
