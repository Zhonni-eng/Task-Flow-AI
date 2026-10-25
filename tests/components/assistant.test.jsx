// Assistant panel through the real app: real storage, real IPC handlers, chat service and
// Anthropic adapter - only the SDK client is a scripted fake (no network). "Today" is
// Wednesday 21 Oct 2026.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAnthropic, modelInfo, planResponse, task, textResponse } from '../helpers/fakeAnthropic.js';
import { TEST_KEY } from '../helpers/fakeSafeStorage.js';
import { allCardTitles, toastMessages } from '../helpers/queries.js';
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

const seedDocument = () =>
  makeDocument({
    categories: [makeCategory({ id: 'cat-home', name: 'Дом' })],
    tasks: [makeTask({ id: 'milk', title: 'Купить молоко', description: 'секретное описание' })],
  });

const start = async (script = [], { enabled = true } = {}) => {
  // The first scripted reply answers the connection test.
  const anthropic = createFakeAnthropic(enabled ? [modelInfo(), ...script] : script);
  env = await renderApp({ document: seedDocument(), anthropic });
  if (enabled) expect(await window.taskflow.ai.connect({ key: TEST_KEY })).toMatchObject({ ok: true, state: { enabled: true } });
  return env;
};
const panel = () => screen.getByRole('complementary', { name: 'ИИ-помощник' });
const openPanel = async () => {
  await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
  await waitFor(() => expect(within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' })).toBeEnabled());
  return panel();
};
const ask = async (text) => {
  const box = within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' });
  await env.user.type(box, text);
  await env.user.click(within(panel()).getByRole('button', { name: 'Отправить' }));
};
// Each review item is named by its kind first ("Новая задача …"), then its title.
const proposalBox = (title, kind = 'Новая задача') => within(panel()).getByRole('checkbox', { name: new RegExp(`^${kind}: ${title}`) });
const saved = () => env.readData().tasks;

describe('availability', () => {
  it('when AI is not configured the panel explains it, offers settings and sends nothing', async () => {
    await start([], { enabled: false });
    await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
    await within(panel()).findByText(/подключите API-ключ в настройках ИИ/);
    expect(within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' })).toBeDisabled();
    expect(within(panel()).getByRole('button', { name: 'Отправить' })).toBeDisabled();
    await env.user.click(within(panel()).getByRole('button', { name: 'Открыть настройки ИИ' }));
    expect(screen.getByRole('dialog', { name: 'ИИ-помощник' })).toBeInTheDocument();
    expect(env.anthropic.requests).toHaveLength(0);
  });

  it('configured: shows the empty state with the privacy note, naming no provider or model', async () => {
    await start();
    const box = await openPanel();
    expect(box).toHaveTextContent('остальные задачи не отправляются');
    expect(box.textContent).not.toMatch(/anthropic|claude|opus/i);
  });
});

describe('creating tasks from a message', () => {
  it('Russian: two tasks for tomorrow are reviewed, created, saved, and undone', async () => {
    await start([
      planResponse({
        reply: 'Создам две задачи на завтра.',
        tasks: [task('Купить продукты', { dueDate: '2026-10-22' }), task('Забрать посылку', { dueDate: '2026-10-22', priority: 'high', categoryId: 'cat-home', subtasks: ['Взять паспорт'] })],
      }),
    ]);
    await openPanel();
    await ask('Завтра купить продукты и забрать посылку');
    await within(panel()).findByText('Создам две задачи на завтра.');
    expect(panel()).toHaveTextContent('Предлагаю 2 задачи:');
    expect(proposalBox('Купить продукты')).toBeChecked();
    expect(proposalBox('Забрать посылку')).toBeChecked();
    expect(panel()).toHaveTextContent('Срок: чт, 22 октября');
    expect(panel()).toHaveTextContent('Высокий · Дом');
    expect(panel()).toHaveTextContent('Подзадачи: Взять паспорт');
    // Nothing exists until confirmed.
    expect(saved().map((item) => item.title)).toEqual(['Купить молоко']);

    await env.user.click(within(panel()).getByRole('button', { name: 'Создать 2 задачи' }));
    await within(panel()).findByText('Созданы 2 задачи.');
    expect(allCardTitles()).toEqual(expect.arrayContaining(['Купить продукты', 'Забрать посылку']));
    const byTitle = (title) => saved().find((item) => item.title === title);
    const created = ['Купить продукты', 'Забрать посылку'].map(byTitle);
    expect(created.map((item) => [item.title, item.dueDate, item.priority, item.categoryId, item.status])).toEqual([
      ['Купить продукты', '2026-10-22', 'medium', null, 'todo'],
      ['Забрать посылку', '2026-10-22', 'high', 'cat-home', 'todo'],
    ]);
    expect(created[1].subtasks.map((subtask) => [subtask.title, subtask.done])).toEqual([['Взять паспорт', false]]);
    expect(within(panel()).queryByRole('button', { name: 'Создать 2 задачи' })).not.toBeInTheDocument();

    await env.user.click(within(panel()).getByRole('button', { name: 'Отменить создание' }));
    await within(panel()).findByText('Отменено: удалены 2 задачи.');
    await waitFor(() => expect(saved().map((item) => item.title)).toEqual(['Купить молоко']));
    expect(within(panel()).queryByRole('button', { name: 'Отменить создание' })).not.toBeInTheDocument();
  });

  it('English: three tasks from one sentence, created in the proposed order', async () => {
    await start([planResponse({ reply: 'Three tasks.', tasks: [task('Finish my report'), task('Email the university'), task('Buy milk')] })]);
    await env.user.click(screen.getByRole('radio', { name: 'EN' }));
    await env.user.click(screen.getByRole('button', { name: 'AI assistant' }));
    const box = screen.getByRole('complementary', { name: 'AI assistant' });
    await waitFor(() => expect(within(box).getByRole('textbox', { name: 'Message to the assistant' })).toBeEnabled());
    await env.user.type(within(box).getByRole('textbox', { name: 'Message to the assistant' }), 'Create three tasks: finish my report, email the university, and buy milk{Enter}');
    await within(box).findByText('I suggest 3 tasks:');
    // "Buy milk" is not a duplicate of "Купить молоко" (different words), so all three are selected.
    await env.user.click(within(box).getByRole('button', { name: 'Create 3 tasks' }));
    await within(box).findByText('3 tasks created.');
    expect(allCardTitles().slice(0, 3)).toEqual(['Finish my report', 'Email the university', 'Buy milk']);
    expect(env.anthropic.requests[0].messages[0].content).toContain('- Interface language: English');
  });

  it('likely duplicates are unticked by default with a warning, and can be ticked', async () => {
    await start([planResponse({ tasks: [task('купить  МОЛОКО'), task('Позвонить маме'), task('позвонить маме')] })]);
    await openPanel();
    await ask('Молоко и маме позвонить');
    await within(panel()).findByText('Предлагаю 3 задачи:');
    expect(proposalBox('купить МОЛОКО')).not.toBeChecked();
    expect(panel()).toHaveTextContent('Похожая задача уже есть — не отмечена.');
    const [first, second] = within(panel()).getAllByRole('checkbox', { name: /^Новая задача: позвонить маме/i });
    expect(first).toBeChecked();
    expect(second).not.toBeChecked();
    expect(panel()).toHaveTextContent('Повторяется в этом списке — не отмечена.');
    expect(within(panel()).getByRole('button', { name: 'Создать 1 задачу' })).toBeEnabled();
    await env.user.click(proposalBox('купить МОЛОКО'));
    expect(within(panel()).getByRole('button', { name: 'Создать 2 задачи' })).toBeEnabled();
  });

  it('invalid proposals cannot be selected and say why', async () => {
    await start([planResponse({ tasks: [task('Плохая дата', { dueDate: '2026-02-30' }), task('Чужая категория', { categoryId: 'cat-nope' }), task('Нормальная')] })]);
    await openPanel();
    await ask('Три задачи');
    await within(panel()).findByText('Предлагаю 3 задачи:');
    expect(proposalBox('Плохая дата')).toBeDisabled();
    expect(proposalBox('Плохая дата')).not.toBeChecked();
    expect(panel()).toHaveTextContent('Нельзя создать: неверная дата');
    expect(proposalBox('Чужая категория')).toBeDisabled();
    expect(panel()).toHaveTextContent('Нельзя создать: такой категории нет');
    expect(proposalBox('Нормальная')).toBeChecked();
  });

  it('declining creates nothing', async () => {
    await start([planResponse({ tasks: [task('Ненужная')] })]);
    await openPanel();
    await ask('Создай ненужную задачу');
    await env.user.click(await within(panel()).findByRole('button', { name: 'Не создавать' }));
    expect(panel()).toHaveTextContent('Предложение отклонено, задачи не созданы.');
    expect(allCardTitles()).toEqual(['Купить молоко']);
  });

  it('a question instead of tasks shows no review list', async () => {
    await start([planResponse({ reply: 'Нужна дата.', question: 'Какая пятница: 23 или 30 октября?' })]);
    await openPanel();
    await ask('Отчёт к пятнице');
    await within(panel()).findByText('Какая пятница: 23 или 30 октября?');
    expect(within(panel()).queryByRole('button', { name: /^Создать/ })).not.toBeInTheDocument();
  });
});

describe('safety at apply time', () => {
  it('re-checks against current data: a category deleted meanwhile blocks the batch', async () => {
    await start([planResponse({ tasks: [task('В категорию Дом', { categoryId: 'cat-home' })] })]);
    await openPanel();
    await ask('Задача для дома');
    await within(panel()).findByText('Предлагаю 1 задачу:');
    // Delete the category from the sidebar while the proposal is open.
    await env.user.click(screen.getAllByRole('button', { name: 'Удалить категорию «Дом»' })[0]);
    await env.user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить категорию' }));
    await env.user.click(within(panel()).getByRole('button', { name: 'Создать 1 задачу' }));
    expect(within(panel()).getByRole('alert')).toHaveTextContent('Задачи изменились');
    expect(allCardTitles()).toEqual(['Купить молоко']);
  });

  it('a failed save is reported as not saved - never as success - and Retry saves it', async () => {
    await start([planResponse({ tasks: [task('Сохранить потом')] })]);
    await openPanel();
    await ask('Одна задача');
    await within(panel()).findByText('Предлагаю 1 задачу:');
    await waitFor(() => expect(saved()).toHaveLength(1));
    env.failNextSaves(1);
    await env.user.click(within(panel()).getByRole('button', { name: 'Создать 1 задачу' }));
    await within(panel()).findByText(/1 изменение видно на доске, но не сохранено/);
    expect(panel()).not.toHaveTextContent('Создана 1 задача.');
    expect(saved().map((item) => item.title)).toEqual(['Купить молоко']);
    const alert = screen.getAllByRole('alert').find((node) => node.textContent.includes('Не удалось сохранить изменения.'));
    await env.user.click(within(alert).getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(saved().map((item) => item.title)).toContain('Сохранить потом'));
  });

  it('no double submission while a reply is pending', async () => {
    let release;
    await start([() => new Promise((resolve) => (release = () => resolve(planResponse({ tasks: [task('Одна')] }))))]);
    await openPanel();
    const box = within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' });
    await env.user.type(box, 'Первое{Enter}');
    await within(panel()).findByText('Помощник думает…');
    await env.user.type(box, 'Второе{Enter}');
    expect(within(panel()).getByRole('button', { name: 'Отправить' })).toBeDisabled();
    release();
    await within(panel()).findByText('Предлагаю 1 задачу:');
    expect(env.anthropic.requests).toHaveLength(1);
  });
});

describe('errors', () => {
  const statusError = (status) => Object.assign(new Error(`HTTP ${status} ${TEST_KEY}`), { status });
  it.each([
    ['an invalid key', statusError(401), 'ИИ-сервис не принял API-ключ'],
    ['a rate limit', statusError(429), 'Слишком много запросов'],
    ['a refusal', planResponse({}, { stop_reason: 'refusal' }), 'не смог обработать этот запрос'],
    ['a truncated reply', textResponse('{"reply":"', { stop_reason: 'max_tokens' }), 'Ответ оказался слишком длинным'],
    ['malformed JSON', textResponse('not json'), 'ответил в неожиданном формате'],
  ])('%s shows a clear error, creates nothing and leaks no key', async (_, response, text) => {
    await start([response]);
    await openPanel();
    await ask('Купить хлеб');
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(text);
    expect(document.body.innerHTML).not.toContain(TEST_KEY);
    expect(allCardTitles()).toEqual(['Купить молоко']);
  });
});

describe('conversation and privacy', () => {
  it('sends the date, categories and message only; keeps context across turns; New conversation resets it', async () => {
    await start([planResponse({ reply: 'Какой день?', question: 'Когда?' }), planResponse({ tasks: [task('Отчёт', { dueDate: '2026-10-23' })] }), planResponse()]);
    await openPanel();
    await ask('Отчёт');
    await within(panel()).findByText('Когда?');
    await ask('В пятницу');
    await within(panel()).findByText('Предлагаю 1 задачу:');
    const [first, second] = env.anthropic.requests;
    expect(first.messages[0].content).toContain('- Today: 2026-10-21 (Wednesday)');
    expect(first.messages[0].content).toContain('- "Дом" (id: cat-home)');
    const sent = JSON.stringify(env.anthropic.requests);
    expect(sent).not.toContain('Купить молоко');
    expect(sent).not.toContain('секретное описание');
    expect(sent).not.toContain(TEST_KEY);
    expect(second.messages).toHaveLength(3);

    await env.user.click(within(panel()).getByRole('button', { name: 'Новый разговор' }));
    expect(within(panel()).queryByText('Когда?')).not.toBeInTheDocument();
    await ask('Новое');
    await waitFor(() => expect(env.anthropic.requests).toHaveLength(3));
    expect(env.anthropic.requests[2].messages).toHaveLength(1);
  });

  it('closing the panel keeps the conversation and tasks; Escape closes it and returns focus', async () => {
    await start([planResponse({ reply: 'Готово к созданию.', tasks: [task('Запомнить')] })]);
    await openPanel();
    await ask('Запомнить');
    await within(panel()).findByText('Готово к созданию.');
    within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' }).focus();
    await env.user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'ИИ-помощник' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ИИ-помощник' })).toHaveFocus();
    expect(allCardTitles()).toEqual(['Купить молоко']);
    await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
    expect(within(panel()).getByText('Готово к созданию.')).toBeInTheDocument();
    expect(toastMessages()).toEqual([]);
  });
});


describe('keyboard focus', () => {
  it('opening the panel focuses the message box, or "Open AI settings" when AI is off; Escape closes it', async () => {
    await start([], { enabled: false });
    await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
    const settingsButton = await within(panel()).findByRole('button', { name: 'Открыть настройки ИИ' });
    await waitFor(() => expect(settingsButton).toHaveFocus());
    await env.user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'ИИ-помощник' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ИИ-помощник' })).toHaveFocus();

    env.anthropic.push(modelInfo());
    await window.taskflow.ai.connect({ key: TEST_KEY });
    await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
    const box = within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' });
    await waitFor(() => expect(box).toHaveFocus());
  });
});
