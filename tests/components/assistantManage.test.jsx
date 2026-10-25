// Full task management by the assistant through the real app (real storage, IPC, chat service and
// Anthropic adapter; only the SDK client is a scripted fake): bulk changes with the affected list,
// deleting with undo, categories, subtasks, questions answered from real data, day plans.
// "Today" is Wednesday 21 Oct 2026, 12:00.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionsResponse, createFakeAnthropic, modelInfo } from '../helpers/fakeAnthropic.js';
import { TEST_KEY } from '../helpers/fakeSafeStorage.js';
import { FIXED_TODAY, makeCategory, makeDocument, makeTask } from '../helpers/fixtures.js';
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
const seedDocument = (settings = {}) =>
  makeDocument({
    categories: [makeCategory({ id: 'cat-study', name: 'Учёба', order: 0 })],
    tasks: [
      makeTask({ id: 'essay', title: 'Сдать эссе', dueDate: '2026-10-19', order: 0, categoryId: 'cat-study' }),
      makeTask({ id: 'lab', title: 'Лабораторная', dueDate: '2026-10-20', order: 1, categoryId: 'cat-study', estimateMinutes: 90 }),
      makeTask({ id: 'exam', title: 'Экзамен по экономике', dueDate: '2026-10-30', order: 2, subtasks: [sub('s1', 'Повторить ВВП'), sub('s2', 'Инфляция')] }),
      makeTask({ id: 'milk', title: 'Купить молоко', order: 3 }),
    ],
    settings,
  });

const start = async (script = [], settings) => {
  env = await renderApp({ document: seedDocument(settings), anthropic: createFakeAnthropic([modelInfo(), ...script]) });
  await window.taskflow.ai.connect({ key: TEST_KEY });
  await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
  await waitFor(() => expect(within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' })).toBeEnabled());
};
const panel = () => screen.getByRole('complementary', { name: 'ИИ-помощник' });
const ask = async (text) => {
  await env.user.type(within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' }), text);
  await env.user.click(within(panel()).getByRole('button', { name: 'Отправить' }));
};
const saved = (id) => env.readData().tasks.find((task) => task.id === id);
const lastContext = () => env.anthropic.requests.at(-1).messages.at(-1).content;
const applyButton = () => within(panel()).getByRole('button', { name: /^Применить/ });

describe('bulk changes', () => {
  it('"Move all overdue tasks to tomorrow": shows the count and every affected task, applies, and undoes', async () => {
    await start([actionsResponse({ reply: 'Перенесу просроченные на завтра.', actions: [{ type: 'bulk', operation: 'update', filter: { due: 'overdue' }, dueDate: '2026-10-22' }] })]);
    await ask('Перенеси все просроченные задачи на завтра');
    await within(panel()).findByText('Перенесу просроченные на завтра.');
    const review = within(panel()).getByRole('checkbox', { name: /^Массовое изменение: Затронет 2 задачи:/ });
    expect(review).toBeChecked();
    const list = panel().querySelector('.ai-proposal__affected');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Сдать эссе (пн, 19 октября)', 'Лабораторная (вт, 20 октября)']);
    expect(panel()).toHaveTextContent('Срок: чт, 22 октября');
    // Nothing changes before confirming.
    expect(saved('essay').dueDate).toBe('2026-10-19');

    await env.user.click(applyButton());
    await waitFor(() => expect([saved('essay').dueDate, saved('lab').dueDate]).toEqual(['2026-10-22', '2026-10-22']));
    expect(saved('exam').dueDate).toBe('2026-10-30');
    expect(saved('milk').dueDate).toBeNull();

    await env.user.click(within(panel()).getByRole('button', { name: 'Отменить изменения' }));
    await waitFor(() => expect([saved('essay').dueDate, saved('lab').dueDate]).toEqual(['2026-10-19', '2026-10-20']));
  });

  it('a bulk change that matches nothing cannot be applied', async () => {
    await start([actionsResponse({ reply: 'Нет таких.', actions: [{ type: 'bulk', operation: 'delete', filter: { titleContains: 'несуществующее' } }] })]);
    await ask('Удали все несуществующие задачи');
    await within(panel()).findByText('Подходящих задач нет — нечего менять.');
    expect(within(panel()).queryByRole('button', { name: /^Применить/ })).not.toBeInTheDocument();
  });
});

describe('deleting', () => {
  it('a deleted task (with its subtasks) comes back with Undo', async () => {
    await start([actionsResponse({ reply: 'Удалю экзамен.', actions: [{ type: 'delete', taskId: 'exam' }] })]);
    await ask('Удали экзамен по экономике');
    await within(panel()).findByText('Удалю экзамен.');
    expect(panel()).toHaveTextContent('Вместе с 2 подзадачами.');
    await env.user.click(applyButton());
    await waitFor(() => expect(saved('exam')).toBeUndefined());
    await env.user.click(within(panel()).getByRole('button', { name: 'Отменить изменения' }));
    await waitFor(() => expect(saved('exam')?.subtasks.map((item) => item.id)).toEqual(['s1', 's2']));
  });
});

describe('categories, descriptions and subtasks', () => {
  it('a proposed category that already exists in another form is reused; a new one is created and removed again by Undo', async () => {
    await start([
      actionsResponse({
        reply: 'Создам задачи.',
        actions: [
          { type: 'create', title: 'Конспект лекции', newCategory: 'Study' },
          { type: 'create', title: 'Купить билеты', newCategory: 'Путешествия', description: 'Поезд в Казань' },
        ],
      }),
    ]);
    await ask('Добавь конспект лекции и купить билеты');
    await within(panel()).findByText('Создам задачи.');
    expect(panel()).toHaveTextContent('Учёба');
    expect(panel()).toHaveTextContent('новая категория «Путешествия»');
    await env.user.click(within(panel()).getByRole('button', { name: 'Создать 2 задачи' }));
    await waitFor(() => expect(env.readData().categories.map((category) => category.name)).toEqual(['Учёба', 'Путешествия']));
    const tasks = env.readData().tasks;
    expect(tasks.find((task) => task.title === 'Конспект лекции').categoryId).toBe('cat-study');
    expect(tasks.find((task) => task.title === 'Купить билеты').description).toBe('Поезд в Казань');

    await env.user.click(within(panel()).getByRole('button', { name: 'Отменить создание' }));
    await waitFor(() => expect(env.readData().categories.map((category) => category.name)).toEqual(['Учёба']));
  });

  it('subtasks of a named task are sent with their ids; completing one changes only it', async () => {
    await start([actionsResponse({ reply: 'Отмечу.', actions: [{ type: 'updateSubtask', taskId: 'exam', subtaskId: 's1', done: 'true' }] })]);
    await ask('В экзамене по экономике отметь «Повторить ВВП» выполненным');
    await within(panel()).findByText('Отмечу.');
    expect(lastContext()).toContain('subtasks: s1 [ ] "Повторить ВВП"; s2 [ ] "Инфляция"');
    await env.user.click(applyButton());
    await waitFor(() => expect(saved('exam').subtasks).toEqual([sub('s1', 'Повторить ВВП', true), sub('s2', 'Инфляция')]));
  });
});

describe('questions and ambiguity', () => {
  it('"What is overdue?" is answered from the real tasks sent in the context; nothing to apply', async () => {
    await start([actionsResponse({ reply: 'Просрочены: «Сдать эссе» и «Лабораторная».' })]);
    await ask('Что у меня просрочено?');
    await within(panel()).findByText('Просрочены: «Сдать эссе» и «Лабораторная».');
    expect(lastContext()).toContain('overdue 2');
    expect(lastContext()).toContain('id: essay');
    expect(lastContext()).toContain('id: lab');
    expect(panel().querySelector('.ai-proposal')).toBeNull();
  });

  it('when several tasks match, the assistant asks instead of guessing; nothing is proposed', async () => {
    await start([actionsResponse({ reply: 'Уточню.', question: 'Какую задачу по учёбе вы имеете в виду?' })]);
    await ask('Отметь задачу по учёбе выполненной');
    await within(panel()).findByText('Какую задачу по учёбе вы имеете в виду?');
    expect(panel().querySelector('.ai-proposal')).toBeNull();
  });
});

describe('day plans', () => {
  const plan = actionsResponse({ reply: 'План на завтра.', actions: [{ type: 'schedule', date: '2026-10-22', items: [{ taskId: 'lab', start: '10:00' }] }] });

  it('without availability in Settings the plan cannot be applied and says why', async () => {
    await start([plan]);
    await ask('Составь план на завтра с лабораторной');
    await within(panel()).findByText('План на завтра.');
    expect(panel()).toHaveTextContent('не задано доступное время (Настройки)');
    expect(within(panel()).queryByRole('button', { name: /^Применить/ })).not.toBeInTheDocument();
  });

  it('with availability it is a suggestion until applied; applying sets the planned slot, not the deadline', async () => {
    await start([plan], { availability: { start: '09:00', end: '18:00' } });
    await ask('Составь план на завтра с лабораторной');
    await within(panel()).findByText('План на завтра.');
    expect(panel()).toHaveTextContent('10:00–11:30 Лабораторная');
    expect(saved('lab').planned).toBeNull();
    await env.user.click(applyButton());
    await waitFor(() => expect(saved('lab')).toMatchObject({ planned: { date: '2026-10-22', time: '10:00' }, dueDate: '2026-10-20' }));
  });
});

describe('completing tasks by saying so (regression: they were shown as renames)', () => {
  // The model echoes each task's title in the `title` field, as strict structured output invites.
  const completeBoth = (reply) =>
    actionsResponse({
      reply,
      actions: [
        { type: 'update', taskId: 'essay', title: 'Сдать эссе', status: 'done' },
        { type: 'update', taskId: 'lab', title: 'Лабораторная (выполнено)', status: 'done' },
      ],
    });

  it.each([
    ['Russian', 'Я всё сделал', 'Отмечу обе задачи выполненными.'],
    ['English', 'No, mark them as completed', 'I will mark both as completed.'],
  ])('%s: status changes to Done (no rename), applied after confirming, reverted by Undo', async (_, message, reply) => {
    await start([actionsResponse({ reply: 'Просрочены «Сдать эссе» и «Лабораторная».' }), completeBoth(reply)]);
    await ask('Что у меня просрочено?');
    await within(panel()).findByText('Просрочены «Сдать эссе» и «Лабораторная».');
    await ask(message);
    await within(panel()).findByText(reply);

    for (const title of ['Сдать эссе', 'Лабораторная']) {
      expect(within(panel()).getByRole('checkbox', { name: new RegExp(`^Смена статуса: ${title}\. Статус: К выполнению → Готово`) })).toBeChecked();
    }
    expect(panel()).not.toHaveTextContent('Название:');
    // Nothing changes before confirming.
    expect([saved('essay').status, saved('lab').status]).toEqual(['todo', 'todo']);

    await env.user.click(within(panel()).getByRole('button', { name: 'Применить 2 изменения' }));
    await waitFor(() => expect([saved('essay').status, saved('lab').status]).toEqual(['done', 'done']));
    expect([saved('essay').title, saved('lab').title]).toEqual(['Сдать эссе', 'Лабораторная']);
    expect(saved('milk').status).toBe('todo');

    await env.user.click(within(panel()).getByRole('button', { name: 'Отменить изменения' }));
    await waitFor(() => expect([saved('essay').status, saved('lab').status]).toEqual(['todo', 'todo']));
  });
});

describe('deleting all tasks (regression: an invalid action that targeted 0 tasks)', () => {
  it('"Delete all tasks, including completed": lists every task, deletes only after confirming, Undo restores', async () => {
    const document = seedDocument();
    document.tasks.push(makeTask({ id: 'old', title: 'Старое дело', status: 'done', completedAt: '2026-10-01T10:00:00.000Z', order: 0 }));
    env = await renderApp({
      document,
      anthropic: createFakeAnthropic([modelInfo(), actionsResponse({ reply: 'Удалю все задачи.', actions: [{ type: 'bulk', operation: 'delete', filter: { scope: 'all' } }] })]),
    });
    await window.taskflow.ai.connect({ key: TEST_KEY });
    await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
    await waitFor(() => expect(within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' })).toBeEnabled());

    await ask('Удали все задачи, включая выполненные');
    await within(panel()).findByText('Удалю все задачи.');
    const review = within(panel()).getByRole('checkbox', { name: /^Массовое удаление: Затронет 5 задач:/ });
    expect(review).toBeChecked();
    expect(panel()).toHaveTextContent('Все задачи, включая выполненные.');
    expect(panel()).toHaveTextContent('Эти задачи будут удалены.');
    const list = panel().querySelector('.ai-proposal__affected');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toContain('Старое дело');
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    // Nothing is deleted before confirming.
    expect(env.readData().tasks).toHaveLength(5);

    await env.user.click(applyButton());
    await waitFor(() => expect(env.readData().tasks).toHaveLength(0));
    await env.user.click(within(panel()).getByRole('button', { name: 'Отменить изменения' }));
    await waitFor(() => expect(env.readData().tasks.map((task) => task.id).sort()).toEqual(['essay', 'exam', 'lab', 'milk', 'old']));
    expect(saved('exam').subtasks).toHaveLength(2);
  });

  it('a bulk change with no criteria is not shown as "affects 0 tasks" and cannot be applied', async () => {
    await start([actionsResponse({ reply: 'Удалю.', actions: [{ type: 'bulk', operation: 'delete', filter: {} }] })]);
    await ask('Удали всё');
    await within(panel()).findByText('Удалю.');
    expect(panel()).not.toHaveTextContent('Затронет 0');
    expect(panel()).toHaveTextContent('Задачи не определены');
    expect(within(panel()).queryByRole('button', { name: /^Применить/ })).not.toBeInTheDocument();
    expect(env.readData().tasks).toHaveLength(4);
  });
});

describe('tags by category', () => {
  it.each([
    ['Russian', 'Добавь теги по категориям', 'учёба', 'Добавлю метку «учёба» задачам из «Учёба».', /Добавить метки: учёба \(имеющиеся сохранятся\)/],
    ['English', 'Tag my tasks by category', 'study', 'I will tag the Study tasks.', /Добавить метки: study/],
  ])('%s: tags are added to the category\'s tasks, existing tags kept; preview shows them; Undo removes them', async (_, message, tag, reply, line) => {
    const document = seedDocument();
    document.tasks[0].labels = ['срочно'];
    env = await renderApp({
      document,
      anthropic: createFakeAnthropic([modelInfo(), actionsResponse({ reply, actions: [{ type: 'bulk', operation: 'update', filter: { categoryId: 'cat-study' }, labels: [tag] }] })]),
    });
    await window.taskflow.ai.connect({ key: TEST_KEY });
    await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
    await waitFor(() => expect(within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' })).toBeEnabled());

    await ask(message);
    await within(panel()).findByText(reply);
    expect(within(panel()).getByRole('checkbox', { name: /^Массовое изменение: Затронет 2 задачи:/ })).toBeChecked();
    expect(panel()).toHaveTextContent(line);
    expect(saved('essay').labels).toEqual(['срочно']);

    await env.user.click(applyButton());
    await waitFor(() => expect([saved('essay').labels, saved('lab').labels]).toEqual([['срочно', tag], [tag]]));
    expect(saved('milk').labels).toEqual([]);
    expect(saved('essay').categoryId).toBe('cat-study');

    await env.user.click(within(panel()).getByRole('button', { name: 'Отменить изменения' }));
    await waitFor(() => expect([saved('essay').labels, saved('lab').labels]).toEqual([['срочно'], []]));
  });

  it('tagging one task shows its tags before and after', async () => {
    const document = seedDocument();
    document.tasks[3].labels = ['дом'];
    env = await renderApp({ document, anthropic: createFakeAnthropic([modelInfo(), actionsResponse({ reply: 'Добавлю.', actions: [{ type: 'update', taskId: 'milk', labels: ['покупки'] }] })]) });
    await window.taskflow.ai.connect({ key: TEST_KEY });
    await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
    await waitFor(() => expect(within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' })).toBeEnabled());
    await ask('Добавь молоку тег покупки');
    await within(panel()).findByText('Добавлю.');
    expect(panel()).toHaveTextContent('Метки: дом → дом, покупки');
    await env.user.click(applyButton());
    await waitFor(() => expect(saved('milk').labels).toEqual(['дом', 'покупки']));
  });
});

describe('tag management (delete everywhere vs remove from tasks, rename, by category)', () => {
  const startTagged = async (action, reply) => {
    const document = seedDocument();
    const byId = Object.fromEntries(document.tasks.map((task) => [task.id, task]));
    byId.essay.labels = ['срочно', 'учёба'];
    byId.lab.labels = ['учёба'];
    byId.milk.labels = ['срочно'];
    env = await renderApp({ document, anthropic: createFakeAnthropic([modelInfo(), actionsResponse({ reply, actions: [action] })]) });
    await window.taskflow.ai.connect({ key: TEST_KEY });
    await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
    await waitFor(() => expect(within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' })).toBeEnabled());
  };
  const labelsOf = () => Object.fromEntries(env.readData().tasks.map((task) => [task.id, task.labels]));
  const before = { essay: ['срочно', 'учёба'], lab: ['учёба'], exam: [], milk: ['срочно'] };
  const listed = () => within(panel().querySelector('.ai-proposal__affected')).getAllByRole('listitem').map((li) => li.textContent);
  const undo = async () => {
    await env.user.click(within(panel()).getByRole('button', { name: 'Отменить изменения' }));
    await waitFor(() => expect(labelsOf()).toEqual(before));
  };

  it('Russian "delete the tag": taken off every task, the tasks stay; preview lists them; Undo restores', async () => {
    await startTagged({ type: 'deleteLabel', label: 'срочно' }, 'Удалю метку «срочно».');
    await ask('Удали метку срочно');
    await within(panel()).findByText('Удалю метку «срочно».');
    expect(lastContext()).toContain('- Tags (tasks with it):\n- "срочно" (2)\n- "учёба" (2)');
    expect(within(panel()).getByRole('checkbox', { name: /^Удаление метки: «срочно»/ })).toBeChecked();
    expect(panel()).toHaveTextContent('Метка будет снята со всех задач, сами задачи останутся.');
    expect(panel()).toHaveTextContent('Затронет 2 задачи:');
    expect(listed()).toEqual(['Сдать эссе (пн, 19 октября)', 'Купить молоко']);
    expect(labelsOf()).toEqual(before);

    await env.user.click(applyButton());
    await waitFor(() => expect(labelsOf()).toEqual({ essay: ['учёба'], lab: ['учёба'], exam: [], milk: [] }));
    expect(env.readData().tasks).toHaveLength(4);
    await undo();
  });

  it('Russian "remove the tag from one task": only that task changes; the tag stays elsewhere', async () => {
    await startTagged({ type: 'update', taskId: 'milk', removeLabels: ['срочно'] }, 'Уберу метку с молока.');
    await ask('Убери метку срочно с задачи купить молоко');
    await within(panel()).findByText('Уберу метку с молока.');
    expect(panel()).toHaveTextContent('Метки: срочно → нет');
    await env.user.click(applyButton());
    await waitFor(() => expect(labelsOf()).toEqual({ ...before, milk: [] }));
    await undo();
  });

  it('English "rename the tag": renamed on every task that has it; Undo restores', async () => {
    await startTagged({ type: 'renameLabel', label: 'учёба', newLabel: 'school' }, 'I will rename the tag.');
    await ask('Rename the tag учёба to school');
    await within(panel()).findByText('I will rename the tag.');
    expect(within(panel()).getByRole('checkbox', { name: /^Переименование метки: «учёба» → «school»/ })).toBeChecked();
    expect(panel()).toHaveTextContent('Метка будет переименована во всех задачах.');
    expect(listed()).toEqual(['Сдать эссе (пн, 19 октября)', 'Лабораторная (вт, 20 октября)']);
    await env.user.click(applyButton());
    await waitFor(() => expect(labelsOf()).toEqual({ essay: ['срочно', 'school'], lab: ['school'], exam: [], milk: ['срочно'] }));
    await undo();
  });

  it('English "remove the tag from Study tasks": a bulk change by category, only tasks that have it', async () => {
    await startTagged({ type: 'bulk', operation: 'update', filter: { categoryId: 'cat-study' }, removeLabels: ['срочно'] }, 'Removing it from Study tasks.');
    await ask('Remove the tag срочно from my Study tasks');
    await within(panel()).findByText('Removing it from Study tasks.');
    expect(within(panel()).getByRole('checkbox', { name: /^Массовое изменение: Затронет 1 задачу:/ })).toBeChecked();
    expect(panel()).toHaveTextContent('Убрать метки: срочно');
    expect(listed()).toEqual(['Сдать эссе (пн, 19 октября)']);
    await env.user.click(applyButton());
    await waitFor(() => expect(labelsOf()).toEqual({ ...before, essay: ['учёба'] }));
    await undo();
  });

  it('deleting a tag no task has cannot be applied', async () => {
    await startTagged({ type: 'deleteLabel', label: 'дом' }, 'Удалю метку.');
    await ask('Удали метку дом');
    await within(panel()).findByText('Удалю метку.');
    expect(panel()).toHaveTextContent('такой метки нет');
    expect(within(panel()).queryByRole('button', { name: /^Применить/ })).not.toBeInTheDocument();
  });
});
