// @vitest-environment node
// Chat service (electron/ai/chatService.cjs): settings gates, per-turn context with an injected
// clock and time zone, append-only history, concurrency, limits. Fake Anthropic client only.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeAnthropic, planResponse, task } from '../helpers/fakeAnthropic.js';
import { createFakeSafeStorage, TEST_KEY } from '../helpers/fakeSafeStorage.js';
import { createTempDir } from '../helpers/tempDir.js';

const require = createRequire(import.meta.url);
const { createChatService, MAX_TURNS } = require('../../electron/ai/chatService.cjs');
const { createAiSettings } = require('../../electron/ai/aiSettings.cjs');

let temp;
let settings;
beforeEach(() => {
  temp = createTempDir();
  settings = createAiSettings({ dir: temp.dir, safeStorage: createFakeSafeStorage() });
});
afterEach(() => {
  temp.remove();
});

// A key that passed a connection test (storing it switches AI on).
const enable = () => {
  expect(settings.storeVerifiedKey('anthropic', TEST_KEY, '2026-10-24T08:00:00.000Z')).toEqual({ ok: true });
};
// 22:30 UTC on Friday 23 Oct 2026: already Saturday 24 Oct in Moscow, still Friday in Los Angeles.
const INSTANT = new Date(Date.UTC(2026, 9, 23, 22, 30));
const service = (fake, options = {}) =>
  createChatService({
    settings,
    getCategories: () => [{ id: 'cat-work', name: 'Работа', order: 0, createdAt: 'x' }],
    now: () => INSTANT,
    timeZone: () => 'Europe/Moscow',
    adapterDeps: { createClient: (opts) => fake.createClient(opts) },
    ...options,
  });
const lastUserContent = (fake) => fake.requests.at(-1).messages.at(-1).content;

describe('gates', () => {
  it('nothing is sent while AI is disabled or has no key', async () => {
    const fake = createFakeAnthropic([planResponse()]);
    const chat = service(fake);
    expect(await chat.send('Купить молоко', 'ru')).toEqual({ ok: false, code: 'AI_DISABLED' });
    enable();
    settings.saveSettings({ enabled: false });
    expect(await chat.send('Купить молоко', 'ru')).toEqual({ ok: false, code: 'AI_DISABLED' });
    expect(fake.requests).toHaveLength(0);
  });

  it('a key that cannot be decrypted counts as no key', async () => {
    enable();
    const unreadable = createAiSettings({ dir: temp.dir, safeStorage: createFakeSafeStorage({ failDecrypt: true }) });
    const fake = createFakeAnthropic([planResponse()]);
    const chat = createChatService({ settings: unreadable, adapterDeps: { createClient: (o) => fake.createClient(o) } });
    expect(await chat.send('x', 'ru')).toEqual({ ok: false, code: 'AI_DISABLED' }); // repaired to disabled on load
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['too long', 'x'.repeat(2001)],
    ['not text', { message: 'x' }],
  ])('rejects a %s message', async (_, message) => {
    enable();
    const fake = createFakeAnthropic([planResponse()]);
    expect(await service(fake).send(message, 'ru')).toEqual({ ok: false, code: 'INVALID_MESSAGE' });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('per-turn context', () => {
  it('gives the model an explicit local date, weekday and time zone from the injected clock', async () => {
    enable();
    const fake = createFakeAnthropic([planResponse(), planResponse()]);
    await service(fake).send('Завтра купить продукты', 'ru');
    expect(lastUserContent(fake)).toContain('- Today: 2026-10-24 (Saturday), now 01:30\n- Time zone: Europe/Moscow');
    await service(fake, { timeZone: () => 'America/Los_Angeles' }).send('Tomorrow buy groceries', 'en');
    expect(lastUserContent(fake)).toContain('- Today: 2026-10-23 (Friday), now 15:30\n- Time zone: America/Los_Angeles');
    expect(lastUserContent(fake)).toContain('- Interface language: English');
  });

  it('sends only the message, the date and category ids/names - no tasks, paths, settings or keys', async () => {
    enable();
    const fake = createFakeAnthropic([planResponse()]);
    await service(fake).send('Создай задачу', 'ru');
    const content = lastUserContent(fake);
    expect(content).toContain('- "Работа" (id: cat-work)');
    expect(content.endsWith('User message:\nСоздай задачу')).toBe(true);
    const everything = JSON.stringify(fake.requests);
    expect(everything).not.toContain(TEST_KEY);
    expect(everything).not.toContain(temp.dir.replace(/\\/g, '\\\\'));
    expect(everything).not.toContain('createdAt');
  });

  it("uses the stored key's provider with its fixed model; the result names neither", async () => {
    enable();
    const fake = createFakeAnthropic([planResponse()]);
    const result = await service(fake).send('x', 'ru');
    expect(result.ok).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['ok', 'plan', 'sharedTaskIds', 'usage']);
    expect(fake.requests[0].model).toBe('claude-opus-5-5');
  });

  it('reports the outcome of every request (for the connection status)', async () => {
    enable();
    const Anthropic = require('@anthropic-ai/sdk');
    const auth = new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }, 'x', new Headers());
    const fake = createFakeAnthropic([planResponse(), auth]);
    const seen = [];
    const chat = service(fake, { onResult: (result) => seen.push(result.ok ? 'ok' : result.code) });
    await chat.send('x', 'ru');
    await chat.send('y', 'ru');
    expect(seen).toEqual(['ok', 'AUTH']);
  });
});

describe('conversation history', () => {
  it('continues the conversation: earlier turns are replayed exactly and only appended to', async () => {
    enable();
    const fake = createFakeAnthropic([planResponse({ reply: 'Какую пятницу?', question: 'Эту или следующую?' }), planResponse({ tasks: [task('Отчёт', { dueDate: '2026-10-30' })] })]);
    const chat = service(fake);
    await chat.send('Отчёт к пятнице', 'ru');
    const first = structuredClone(fake.requests[0].messages);
    const second = await chat.send('Следующую', 'ru');
    expect(second.ok).toBe(true);
    const replayed = fake.requests[1].messages;
    expect(replayed).toHaveLength(3);
    expect(replayed[0]).toEqual(first[0]);
    expect(replayed[1]).toEqual({ role: 'assistant', content: planResponse({ reply: 'Какую пятницу?', question: 'Эту или следующую?' }).content });
    expect(chat.turnCount()).toBe(2);
  });

  it('a failed turn is not added, and a new conversation starts empty', async () => {
    enable();
    const fake = createFakeAnthropic([new Error('network'), planResponse(), planResponse()]);
    const chat = service(fake);
    expect((await chat.send('one', 'ru')).ok).toBe(false);
    await chat.send('two', 'ru');
    expect(fake.requests[1].messages).toHaveLength(1);
    chat.reset();
    await chat.send('three', 'ru');
    expect(fake.requests[2].messages).toHaveLength(1);
  });

  it('one request at a time; a reply that arrives after a reset is discarded', async () => {
    enable();
    let release;
    const fake = createFakeAnthropic([() => new Promise((resolve) => (release = () => resolve(planResponse({ tasks: [task('A')] }))))]);
    const chat = service(fake);
    const pending = chat.send('first', 'ru');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await chat.send('second', 'ru')).toEqual({ ok: false, code: 'BUSY' });
    chat.reset();
    release();
    expect(await pending).toEqual({ ok: false, code: 'CANCELLED' });
    expect(chat.turnCount()).toBe(0);
    expect(fake.requests).toHaveLength(1);
  });

  it(`stops at ${MAX_TURNS} turns instead of trimming history`, async () => {
    enable();
    const fake = createFakeAnthropic(Array.from({ length: MAX_TURNS }, () => planResponse()));
    const chat = service(fake);
    for (let i = 0; i < MAX_TURNS; i += 1) expect((await chat.send(`m${i}`, 'ru')).ok).toBe(true);
    expect(await chat.send('one more', 'ru')).toEqual({ ok: false, code: 'CONVERSATION_LIMIT' });
    expect(fake.requests).toHaveLength(MAX_TURNS);
    chat.reset();
    fake.push(planResponse());
    expect((await chat.send('fresh', 'ru')).ok).toBe(true);
  });
});

describe('task context (Stage 3)', () => {
  const savedTasks = [
    { id: 'report', title: 'Подготовить отчёт', status: 'todo', dueDate: '2026-10-25', description: 'секретные цифры', labels: ['финансы'], subtasks: [] },
    { id: 'bank', title: 'Call the bank', status: 'inProgress', dueDate: null, description: '', labels: [], subtasks: [] },
    { id: 'secret', title: 'Секретный проект', status: 'todo', dueDate: null, description: 'не отправлять', labels: [], subtasks: [] },
  ];
  const withTasks = (fake) => service(fake, { getTasks: () => savedTasks });

  it('describes only the tasks the message is about, with id, title, status and due date', async () => {
    enable();
    const fake = createFakeAnthropic([planResponse()]);
    const result = await withTasks(fake).send('Отчёт готов', 'ru');
    const content = lastUserContent(fake);
    expect(content).toContain('- id: report | "Подготовить отчёт" | todo | due: 2026-10-25');
    expect(content).not.toContain('Call the bank');
    expect(content).not.toContain('Секретный');
    expect(content).not.toContain('секретные цифры');
    // Tags are sent (the assistant manages them); descriptions never are.
    expect(content).toContain('tags: "финансы"');
    expect(result.sharedTaskIds).toEqual(['report']);
  });

  it('says so when nothing matches', async () => {
    enable();
    const fake = createFakeAnthropic([planResponse()]);
    await withTasks(fake).send('Перенеси прогулку', 'ru');
    expect(lastUserContent(fake)).toContain('- (no matching existing tasks)');
  });

  it('follow-ups: tasks of this session are included by id even without matching words', async () => {
    enable();
    const fake = createFakeAnthropic([planResponse()]);
    await withTasks(fake).send('Move it to Friday', 'en', ['bank', 'no-such-task']);
    expect(lastUserContent(fake)).toContain('- id: bank | "Call the bank" | inProgress');
    expect(lastUserContent(fake)).not.toContain('no-such-task');
  });

  it('shared task ids accumulate over the conversation, and a reset clears them', async () => {
    enable();
    const fake = createFakeAnthropic([planResponse(), new Error('down'), planResponse(), planResponse()]);
    const chat = withTasks(fake);
    expect((await chat.send('Отчёт', 'ru')).sharedTaskIds).toEqual(['report']);
    expect((await chat.send('bank', 'en')).ok).toBe(false); // failed turn: nothing added
    expect((await chat.send('the bank', 'en')).sharedTaskIds).toEqual(['report', 'bank']);
    chat.reset();
    expect((await chat.send('the bank', 'en')).sharedTaskIds).toEqual(['bank']);
  });
});

describe('follow-ups after a question ("mark them as completed")', () => {
  // Regression: tasks only SHOWN in an earlier turn (not changed) were missing from the follow-up's
  // context, so "No, mark them as completed" had no tasks to set to done.
  it('tasks shown earlier in the conversation are in the next turn\'s context', async () => {
    enable();
    const tasks = [
      { id: 'essay', title: 'Сдать эссе', status: 'todo', dueDate: '2026-10-20' },
      { id: 'lab', title: 'Лабораторная', status: 'todo', dueDate: '2026-10-21' },
      { id: 'milk', title: 'Купить молоко', status: 'todo', dueDate: null },
    ];
    const fake = createFakeAnthropic([planResponse({ reply: 'Просрочены эссе и лабораторная.' }), planResponse()]);
    const chat = service(fake, { getTasks: () => tasks });
    await chat.send('Что у меня просрочено?', 'ru');
    expect(lastUserContent(fake)).toContain('id: essay');
    await chat.send('Нет, отметь их выполненными', 'ru');
    const followUp = lastUserContent(fake);
    expect(followUp).toContain('id: essay');
    expect(followUp).toContain('id: lab');
    expect(followUp).not.toContain('id: milk');
  });
});
