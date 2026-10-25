// Assistant changes to existing tasks (status and due date) through the real app: real storage,
// IPC, chat service and Anthropic adapter; only the SDK client is a scripted fake.
// "Today" is Wednesday 21 Oct 2026.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAnthropic, modelInfo, planResponse, task, textResponse } from '../helpers/fakeAnthropic.js';
import { TEST_KEY } from '../helpers/fakeSafeStorage.js';
import { cardTitles } from '../helpers/queries.js';
import { FIXED_TODAY, makeDocument, makeTask } from '../helpers/fixtures.js';
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

const seedDocument = () =>
  makeDocument({
    tasks: [
      makeTask({ id: 'report', title: 'Подготовить отчёт', status: 'todo', dueDate: '2026-10-25', order: 0, description: 'цифры за квартал' }),
      makeTask({ id: 'bank', title: 'Call the bank', status: 'inProgress', dueDate: null, order: 0 }),
      makeTask({ id: 'mom', title: 'Позвонить маме', status: 'todo', order: 1 }),
      makeTask({ id: 'dad', title: 'Позвонить папе', status: 'todo', order: 2 }),
      makeTask({ id: 'secret', title: 'Секретный проект', status: 'todo', order: 3, description: 'не отправлять' }),
    ],
  });

const start = async (script = []) => {
  // The first scripted reply answers the connection test.
  env = await renderApp({ document: seedDocument(), anthropic: createFakeAnthropic([modelInfo(), ...script]) });
  await window.taskflow.ai.connect({ key: TEST_KEY });
  await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
  await waitFor(() => expect(within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' })).toBeEnabled());
  return env;
};
const panel = () => screen.getByRole('complementary', { name: 'ИИ-помощник' });
const ask = async (text) => {
  await env.user.type(within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' }), text);
  await env.user.click(within(panel()).getByRole('button', { name: 'Отправить' }));
};
const item = (kind, title) => within(panel()).getByRole('checkbox', { name: new RegExp(`^${kind}: ${title}`) });
const statusItem = (title) => item('Смена статуса', title);
const dueItem = (title) => item('Смена срока', title);
const saved = (id) => env.readData().tasks.find((entry) => entry.id === id);
const lastRequestContext = () => env.anthropic.requests.at(-1).messages.at(-1).content;

describe('status changes', () => {
  it('Russian: "Отчёт готов" → review "To Do → Done" → apply → saved; only the relevant task was sent', async () => {
    await start([planResponse({ reply: 'Отмечу отчёт как готовый.', statusChanges: [{ taskId: 'report', status: 'done' }] })]);
    await ask('Отчёт готов');
    await within(panel()).findByText('Отмечу отчёт как готовый.');
    expect(statusItem('Подготовить отчёт')).toBeChecked();
    expect(panel()).toHaveTextContent('Статус: К выполнению → Готово');
    expect(saved('report').status).toBe('todo'); // nothing changes before confirmation

    const context = lastRequestContext();
    expect(context).toContain('- id: report | "Подготовить отчёт" | todo | due: 2026-10-25');
    for (const hidden of ['Call the bank', 'Позвонить', 'Секретный', 'цифры за квартал', 'не отправлять']) expect(context).not.toContain(hidden);

    await env.user.click(within(panel()).getByRole('button', { name: 'Применить 1 изменение' }));
    await within(panel()).findByText('Готово. Создано задач: 0, изменено: 1.');
    expect(cardTitles('Готово')).toContain('Подготовить отчёт');
    await waitFor(() => expect(saved('report').status).toBe('done'));
    expect(saved('report').dueDate).toBe('2026-10-25');
  });

  it('a change that changes nothing is shown but not selected', async () => {
    await start([planResponse({ statusChanges: [{ taskId: 'bank', status: 'inProgress' }] })]);
    await ask('the bank call is in progress');
    await within(panel()).findByText('Уже так — не отмечено.');
    expect(statusItem('Call the bank')).not.toBeChecked();
  });
});

describe('due-date changes and follow-ups', () => {
  it('English: move to Friday, then a follow-up "remove its due date" clears it', async () => {
    await start([
      planResponse({ reply: 'Moving the bank call to Friday.', dueDateChanges: [{ taskId: 'bank', dueDate: '2026-10-23' }] }),
      planResponse({ reply: 'Removing its due date.', dueDateChanges: [{ taskId: 'bank', dueDate: '' }] }),
    ]);
    await ask('Move the bank call to Friday');
    await within(panel()).findByText('Moving the bank call to Friday.');
    expect(panel()).toHaveTextContent('Срок: без срока → пт, 23 октября');
    await env.user.click(within(panel()).getByRole('button', { name: 'Применить 1 изменение' }));
    await waitFor(() => expect(saved('bank').dueDate).toBe('2026-10-23'));

    // The follow-up has no words of the title; the task is included because this session changed it.
    await ask('Actually, remove its due date');
    await within(panel()).findByText('Removing its due date.');
    expect(lastRequestContext()).toContain('- id: bank | "Call the bank" | inProgress | due: 2026-10-23');
    expect(env.anthropic.requests.at(-1).messages).toHaveLength(3);
    expect(panel()).toHaveTextContent('Срок: пт, 23 октября → без срока');
    await env.user.click(within(panel()).getAllByRole('button', { name: 'Применить 1 изменение' }).at(-1));
    await waitFor(() => expect(saved('bank').dueDate).toBeNull());
  });

  it('mixed proposal: a new task and a due-date change are applied together', async () => {
    await start([planResponse({ tasks: [task('Купить подарок')], dueDateChanges: [{ taskId: 'report', dueDate: '2026-10-30' }] })]);
    await ask('Отчёт к 30-му и купить подарок');
    await within(panel()).findByText('Предлагаю 2 изменения:');
    await env.user.click(within(panel()).getByRole('button', { name: 'Применить 2 изменения' }));
    await within(panel()).findByText('Готово. Создано задач: 1, изменено: 1.');
    await waitFor(() => expect(saved('report').dueDate).toBe('2026-10-30'));
    expect(env.readData().tasks.some((entry) => entry.title === 'Купить подарок')).toBe(true);
  });
});

describe('ambiguity and invalid references', () => {
  it('two matching tasks: the assistant asks and nothing is proposed; both candidates were shown', async () => {
    await start([planResponse({ reply: 'Подходят две задачи.', question: 'Кому позвонить: маме или папе?' })]);
    await ask('Позвонить — готово');
    await within(panel()).findByText('Кому позвонить: маме или папе?');
    expect(within(panel()).queryByRole('button', { name: /Применить|Создать/ })).not.toBeInTheDocument();
    expect(lastRequestContext()).toContain('id: mom');
    expect(lastRequestContext()).toContain('id: dad');
  });

  it('ids the assistant was never shown - even of existing tasks - and unknown ids cannot be selected', async () => {
    await start([planResponse({ statusChanges: [{ taskId: 'secret', status: 'done' }, { taskId: 'made-up-id', status: 'done' }, { taskId: 'report', status: 'inProgress' }] })]);
    await ask('Отчёт в работу');
    await within(panel()).findByText('Предлагаю 3 изменения:');
    const boxes = within(panel()).getAllByRole('checkbox', { name: /^Смена статуса: Задача не найдена/ });
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).toBeDisabled();
    expect(panel()).toHaveTextContent('Нельзя применить: эта задача не обсуждалась в разговоре');
    expect(statusItem('Подготовить отчёт')).toBeChecked();
    await env.user.click(within(panel()).getByRole('button', { name: 'Применить 1 изменение' }));
    await waitFor(() => expect(saved('report').status).toBe('inProgress'));
    expect(saved('secret').status).toBe('todo');
  });

  it('conflicting changes to the same task stay unticked, and applying both is blocked', async () => {
    await start([planResponse({ statusChanges: [{ taskId: 'report', status: 'done' }, { taskId: 'report', status: 'inProgress' }] })]);
    await ask('Отчёт готов, нет, в работе');
    await within(panel()).findByText('Предлагаю 2 изменения:');
    const [first, second] = within(panel()).getAllByRole('checkbox', { name: /^Смена статуса: Подготовить отчёт/ });
    expect(first).not.toBeChecked();
    expect(second).not.toBeChecked();
    expect(panel()).toHaveTextContent('Противоречит другому изменению этой задачи — не отмечено.');
    await env.user.click(first);
    await env.user.click(second);
    await env.user.click(within(panel()).getByRole('button', { name: 'Применить 2 изменения' }));
    expect(within(panel()).getByRole('alert')).toHaveTextContent('Выбрано несколько разных изменений одной задачи');
    expect(saved('report').status).toBe('todo');
  });

  it('a task deleted before confirming blocks the change (stale id)', async () => {
    await start([planResponse({ statusChanges: [{ taskId: 'report', status: 'done' }] })]);
    await ask('Отчёт готов');
    await within(panel()).findByText('Предлагаю 1 изменение:');
    await env.user.click(screen.getByRole('button', { name: 'Удалить задачу «Подготовить отчёт»' }));
    await env.user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить' }));
    await env.user.click(within(panel()).getByRole('button', { name: 'Применить 1 изменение' }));
    expect(within(panel()).getByRole('alert')).toHaveTextContent('Задачи изменились');
    expect(env.readData().tasks.some((entry) => entry.id === 'report')).toBe(false);
  });

  it('a malformed change list is an error and changes nothing', async () => {
    await start([textResponse('{"reply":"","question":"","tasks":[],"statusChanges":"all","dueDateChanges":[]}')]);
    await ask('Все готово');
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('ответил в неожиданном формате');
  });
});

describe('undo and intervening edits', () => {
  it('Undo restores status and due date exactly', async () => {
    await start([planResponse({ statusChanges: [{ taskId: 'report', status: 'done' }], dueDateChanges: [{ taskId: 'bank', dueDate: '2026-10-23' }] })]);
    await ask('Отчёт готов, the bank call on Friday');
    await env.user.click(await within(panel()).findByRole('button', { name: 'Применить 2 изменения' }));
    await within(panel()).findByText('Готово. Создано задач: 0, изменено: 2.');
    await env.user.click(within(panel()).getByRole('button', { name: 'Отменить изменения' }));
    await within(panel()).findByText('Отменено. Удалено задач: 0, возвращено изменений: 2.');
    await waitFor(() => expect([saved('report').status, saved('bank').dueDate]).toEqual(['todo', null]));
  });

  it('Undo keeps changes the user made in between and says so', async () => {
    await start([planResponse({ tasks: [task('Новая задача от ИИ')], statusChanges: [{ taskId: 'report', status: 'done' }], dueDateChanges: [{ taskId: 'bank', dueDate: '2026-10-23' }] })]);
    await ask('Отчёт готов, the bank call on Friday, и новая задача');
    await env.user.click(await within(panel()).findByRole('button', { name: 'Применить 3 изменения' }));
    await within(panel()).findByText('Готово. Создано задач: 1, изменено: 2.');

    // The user edits two of the three things by hand.
    await env.user.click(screen.getByRole('button', { name: 'Список' }));
    await env.user.selectOptions(screen.getByRole('combobox', { name: 'Статус задачи «Подготовить отчёт»' }), 'В работе');
    await env.user.click(screen.getByRole('button', { name: 'Редактировать задачу «Новая задача от ИИ»' }));
    const dialog = screen.getByRole('dialog', { name: 'Редактирование задачи' });
    await env.user.type(within(dialog).getByRole('textbox', { name: /Название/ }), ' (важно)');
    await env.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    await env.user.click(within(panel()).getByRole('button', { name: 'Отменить изменения' }));
    await within(panel()).findByText(/Отменено\. Удалено задач: 0, возвращено изменений: 1\. Не тронуты 2 задачи, изменённые после этого\./);
    await waitFor(() => expect(saved('bank').dueDate).toBeNull());
    expect(saved('report').status).toBe('inProgress');
    expect(env.readData().tasks.some((entry) => entry.title === 'Новая задача от ИИ (важно)')).toBe(true);
  });

  it('a failed save of a change is reported as not saved, never as success', async () => {
    await start([planResponse({ statusChanges: [{ taskId: 'report', status: 'done' }] })]);
    await ask('Отчёт готов');
    await within(panel()).findByText('Предлагаю 1 изменение:');
    await waitFor(() => expect(env.readData().tasks).toHaveLength(5));
    env.failNextSaves(1);
    await env.user.click(within(panel()).getByRole('button', { name: 'Применить 1 изменение' }));
    await within(panel()).findByText(/1 изменение видно на доске, но не сохранено/);
    expect(panel()).not.toHaveTextContent('Готово. Создано');
    expect(saved('report').status).toBe('todo');
  });

  it('cancelling (declining) changes nothing', async () => {
    await start([planResponse({ statusChanges: [{ taskId: 'report', status: 'done' }] })]);
    await ask('Отчёт готов');
    await env.user.click(await within(panel()).findByRole('button', { name: 'Не создавать' }));
    expect(saved('report').status).toBe('todo');
  });
});

describe('AI off and request hygiene', () => {
  it('when AI is switched off mid-session, nothing is sent and nothing changes', async () => {
    await start([planResponse({ statusChanges: [{ taskId: 'report', status: 'done' }] })]);
    await window.taskflow.ai.saveSettings({ enabled: false });
    await ask('Отчёт готов');
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('ИИ-помощник выключен');
    expect(env.anthropic.requests).toHaveLength(0);
    expect(saved('report').status).toBe('todo');
  });

  it('New conversation forgets which tasks were shown: an old id can no longer be targeted', async () => {
    await start([planResponse({ reply: 'Ок.' }), planResponse({ statusChanges: [{ taskId: 'report', status: 'done' }] })]);
    await ask('Отчёт');
    await within(panel()).findByText('Ок.');
    await env.user.click(within(panel()).getByRole('button', { name: 'Новый разговор' }));
    await ask('Готово');
    await within(panel()).findByText('Нельзя применить: эта задача не обсуждалась в разговоре');
    expect(statusItem('Задача не найдена')).toBeDisabled();
    expect(within(panel()).queryByRole('button', { name: /Применить|Создать/ })).not.toBeInTheDocument();
  });
});
