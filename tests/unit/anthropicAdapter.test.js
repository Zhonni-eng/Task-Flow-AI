// @vitest-environment node
// Anthropic adapter (electron/ai/providers/anthropic.cjs): request construction, response parsing
// and error mapping. Fake clients, or the real SDK with an injected fetch - never the network.
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAnthropic, modelInfo, planResponse, task, textResponse } from '../helpers/fakeAnthropic.js';
import { TEST_KEY } from '../helpers/fakeSafeStorage.js';

const require = createRequire(import.meta.url);
const { createAnthropicAdapter, defaultCreateClient, errorCode, RESPONSE_SCHEMA, TEST_TIMEOUT_MS, toPlan } = require('../../electron/ai/providers/anthropic.cjs');
const { SYSTEM_PROMPT } = require('../../electron/ai/prompt.cjs');
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default ?? sdk;

const run = async (script, { history = [], userContent = 'App context: ...\n\nUser message:\nhi', model = 'claude-opus-5-5' } = {}) => {
  const fake = createFakeAnthropic(script);
  const adapter = createAnthropicAdapter({ createClient: (options) => fake.createClient(options) });
  const result = await adapter.proposePlan({ apiKey: TEST_KEY, model, history, userContent });
  return { fake, result };
};

describe('request construction', () => {
  it('sends the selected model, cached instructions, structured-output schema and the new turn', async () => {
    const { fake } = await run([planResponse()], { model: 'claude-haiku-5-5' });
    const [request] = fake.requests;
    expect(request.model).toBe('claude-haiku-5-5');
    expect(request.max_tokens).toBe(16000);
    expect(request.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    expect(request.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } });
    expect(request.messages).toEqual([{ role: 'user', content: 'App context: ...\n\nUser message:\nhi' }]);
    // No sampling parameters or disabled thinking (rejected by current models), no prefill.
    expect(Object.keys(request).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
  });

  it('the key goes only to the client, never into the request body', async () => {
    const { fake } = await run([planResponse()]);
    expect(fake.clients[0].apiKey).toBe(TEST_KEY);
    expect(JSON.stringify(fake.requests)).not.toContain(TEST_KEY);
  });

  it('replays the stored history unchanged before the new turn (append-only)', async () => {
    const history = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'abc' }, { type: 'text', text: '{"reply":"","question":"","tasks":[]}' }] },
    ];
    const { fake, result } = await run([planResponse()], { history });
    expect(fake.requests[0].messages).toEqual([...history, { role: 'user', content: 'App context: ...\n\nUser message:\nhi' }]);
    // The new turn returned for storage keeps the assistant content exactly, thinking block included.
    expect(result.turn[1].content).toEqual(planResponse().content);
  });

  it('the schema is strict: a fixed set of action types, every field required, nothing extra anywhere', () => {
    expect(RESPONSE_SCHEMA.required).toEqual(['reply', 'question', 'actions']);
    const action = RESPONSE_SCHEMA.properties.actions.items;
    expect(action.properties.type.enum).toEqual(['create', 'update', 'delete', 'addSubtask', 'updateSubtask', 'deleteSubtask', 'moveSubtask', 'bulk', 'schedule', 'renameLabel', 'deleteLabel']);
    expect(action.properties.clear.items.enum).toEqual(['dueDate', 'dueTime', 'description', 'categoryId', 'reminders', 'recurrence', 'estimateMinutes', 'planned']);
    // Strict structured output: every object lists all its properties as required and allows no others.
    const objects = [];
    const walk = (node) => {
      if (node?.type === 'object') objects.push(node);
      for (const child of Object.values(node?.properties ?? {})) walk(child);
      if (node?.items) walk(node.items);
    };
    walk(RESPONSE_SCHEMA);
    expect(objects.length).toBeGreaterThanOrEqual(5);
    for (const node of objects) {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties));
    }
  });
});

describe('response parsing', () => {
  it('turns proposed tasks into create actions ("" means not set)', async () => {
    const { result } = await run([
      planResponse({
        reply: 'Создам две задачи на завтра.',
        tasks: [task('Купить продукты', { dueDate: '2026-10-22' }), task('Забрать посылку', { dueDate: '2026-10-22', priority: 'high', categoryId: 'cat-1', subtasks: ['Взять паспорт'] })],
      }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.plan).toEqual({
      reply: 'Создам две задачи на завтра.',
      question: '',
      actions: [
        { type: 'create', title: 'Купить продукты', dueDate: '2026-10-22', priority: 'medium' },
        { type: 'create', title: 'Забрать посылку', dueDate: '2026-10-22', priority: 'high', categoryId: 'cat-1', subtasks: ['Взять паспорт'] },
      ],
    });
  });

  it('no tasks becomes a single "none" action (a question or plain reply)', async () => {
    const { result } = await run([planResponse({ reply: 'Уточню.', question: 'Какую пятницу вы имеете в виду?' })]);
    expect(result.plan).toEqual({ reply: 'Уточню.', question: 'Какую пятницу вы имеете в виду?', actions: [{ type: 'none' }] });
  });

  it('drops fields the model was not asked for, leaving the rest to the app validator', () => {
    const plan = toPlan({ reply: '', question: '', tasks: [{ ...task('A'), status: 'done', id: 'chosen', execute: 'rm' }] });
    expect(plan.actions).toEqual([{ type: 'create', title: 'A', priority: 'medium' }]);
  });

  it.each([
    ['a refusal', planResponse({}, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null } }), 'REFUSED'],
    ['a max_tokens cut-off', textResponse('{"reply":"Созда', { stop_reason: 'max_tokens' }), 'TRUNCATED'],
    ['invalid JSON', textResponse('Sure! Here are your tasks: ...'), 'MALFORMED'],
    ['JSON that is not an object', textResponse('["a","b"]'), 'MALFORMED'],
    ['missing fields', textResponse('{"reply":"ok"}'), 'MALFORMED'],
    ['a non-array task list', textResponse('{"reply":"","question":"","tasks":"buy milk"}'), 'MALFORMED'],
    ['a task that is not an object', textResponse('{"reply":"","question":"","tasks":["buy milk"]}'), 'MALFORMED'],
    ['more than 50 tasks', planResponse({ tasks: Array.from({ length: 51 }, (_, i) => task(`T${i}`)) }), 'MALFORMED'],
    ['no text block', { ...planResponse(), content: [{ type: 'thinking', thinking: '', signature: 'x' }] }, 'MALFORMED'],
    ['no content at all', { stop_reason: 'end_turn' }, 'MALFORMED'],
    ['an oversized reply', textResponse(`{"reply":"${'x'.repeat(70 * 1024)}","question":"","tasks":[]}`), 'MALFORMED'],
  ])('rejects %s', async (_, response, code) => {
    const { result } = await run([response]);
    expect(result).toEqual({ ok: false, code });
  });
});

describe('errors', () => {
  const statusError = (Class, status) => new Class(status, { type: 'error', error: { type: 'x', message: `secret ${TEST_KEY}` } }, `failure ${TEST_KEY}`, new Headers());

  it.each([
    ['invalid API key (401)', () => statusError(Anthropic.AuthenticationError, 401), 'AUTH'],
    ['no access (403)', () => statusError(Anthropic.PermissionDeniedError, 403), 'PERMISSION'],
    ['unknown model (404)', () => statusError(Anthropic.NotFoundError, 404), 'MODEL_UNAVAILABLE'],
    ['rate limit (429)', () => statusError(Anthropic.RateLimitError, 429), 'RATE_LIMIT'],
    ['overloaded (529)', () => statusError(Anthropic.APIError, 529), 'OVERLOADED'],
    ['server error (500)', () => statusError(Anthropic.InternalServerError, 500), 'PROVIDER_ERROR'],
    ['bad request (400)', () => statusError(Anthropic.BadRequestError, 400), 'BAD_REQUEST'],
    ['timeout', () => new Anthropic.APIConnectionTimeoutError(), 'TIMEOUT'],
    ['network failure', () => new Anthropic.APIConnectionError({ message: 'Connection error.' }), 'NETWORK'],
    ['anything else', () => new Error(`unexpected ${TEST_KEY}`), 'PROVIDER_ERROR'],
  ])('maps %s to a code without any message text', async (_, makeError, code) => {
    const { result } = await run([makeError()]);
    expect(result).toEqual({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
    expect(errorCode(makeError())).toBe(code);
  });
});

describe('connection test', () => {
  const statusError = (Class, status) => new Class(status, { type: 'error', error: { type: 'x', message: `secret ${TEST_KEY}` } }, `failure ${TEST_KEY}`, new Headers());
  const test = async (script) => {
    const fake = createFakeAnthropic(script);
    const adapter = createAnthropicAdapter({ createClient: (options) => fake.createClient(options) });
    const result = await adapter.testConnection({ apiKey: TEST_KEY, model: 'claude-opus-5-5' });
    return { fake, result };
  };

  it('is one "retrieve model" request - no messages, no task data - with a short timeout', async () => {
    const { fake, result } = await test([modelInfo()]);
    expect(result).toEqual({ ok: true });
    expect(fake.modelRequests).toEqual(['claude-opus-5-5']);
    expect(fake.requests).toHaveLength(0);
    expect(fake.clients[0].options).toEqual({ timeout: TEST_TIMEOUT_MS, maxRetries: 1 });
    expect(TEST_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it.each([
    ['invalid key (401)', () => statusError(Anthropic.AuthenticationError, 401), 'AUTH'],
    ['no access (403)', () => statusError(Anthropic.PermissionDeniedError, 403), 'PERMISSION'],
    ['model not available (404)', () => statusError(Anthropic.NotFoundError, 404), 'MODEL_UNAVAILABLE'],
    ['rate limit (429)', () => statusError(Anthropic.RateLimitError, 429), 'RATE_LIMIT'],
    ['outage (500)', () => statusError(Anthropic.InternalServerError, 500), 'PROVIDER_ERROR'],
    ['overloaded (529)', () => statusError(Anthropic.APIError, 529), 'OVERLOADED'],
    ['timeout', () => new Anthropic.APIConnectionTimeoutError(), 'TIMEOUT'],
    ['network failure', () => new Anthropic.APIConnectionError({ message: 'Connection error.' }), 'NETWORK'],
  ])('%s fails with %s and no message text', async (_, makeError, code) => {
    const { result } = await test([makeError()]);
    expect(result).toEqual({ ok: false, code });
  });

  it.each([
    ['nothing', null],
    ['a different kind of object', { type: 'message', id: 'x' }],
    ['a model without an id', { type: 'model' }],
    ['a string', 'ok'],
  ])('an unsupported response (%s) is not reported as success', async (_, response) => {
    const { result } = await test([response]);
    expect(result).toEqual({ ok: false, code: 'MALFORMED' });
  });

  it('with the real SDK: one GET to api.anthropic.com/v1/models/<model>, nothing else', async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: init.body, auth: new Headers(init.headers).get('authorization') });
      return new Response(JSON.stringify(modelInfo()), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
    };
    const adapter = createAnthropicAdapter({ createClient: (options) => defaultCreateClient({ ...options, fetch }) });
    expect(await adapter.testConnection({ apiKey: TEST_KEY, model: 'claude-opus-5-5' })).toEqual({ ok: true });
    expect(calls).toEqual([{ url: 'https://api.anthropic.com/v1/models/claude-opus-5-5', method: 'GET', body: undefined, auth: `Bearer ${TEST_KEY}` }]);
  });
});

describe('the real SDK with an injected fetch (no network)', () => {
  const saved = { base: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN };
  afterEach(() => {
    for (const [name, value] of [['ANTHROPIC_BASE_URL', saved.base], ['ANTHROPIC_AUTH_TOKEN', saved.token]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const fakeFetch = (respond) => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return respond();
    };
    return { calls, fetch };
  };
  const adapterWith = (fetch) => createAnthropicAdapter({ createClient: ({ apiKey }) => defaultCreateClient({ apiKey, fetch }) });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-should-retry': 'false', 'request-id': 'req_test' } });

  it('posts to api.anthropic.com only, with the key header - even if the environment says otherwise', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://attacker.example';
    process.env.ANTHROPIC_AUTH_TOKEN = 'leaked-token';
    const { calls, fetch } = fakeFetch(() => json(200, planResponse({ reply: 'ok', tasks: [task('Buy milk')] })));
    const result = await adapterWith(fetch).proposePlan({ apiKey: TEST_KEY, model: 'claude-opus-5-5', history: [], userContent: 'hi' });
    expect(result).toMatchObject({ ok: true, plan: { actions: [{ type: 'create', title: 'Buy milk' }] } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    // SDK 1.x sends the key as a bearer credential; the environment token is never used.
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    expect(JSON.stringify([...calls[0].headers.entries()])).not.toContain('leaked-token');
    expect(calls[0].body).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low', format: { type: 'json_schema' } } });
  });

  it.each([
    [401, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [404, 'MODEL_UNAVAILABLE'],
    [529, 'OVERLOADED'],
  ])('HTTP %s from the API becomes %s', async (status, code) => {
    const { fetch } = fakeFetch(() => json(status, { type: 'error', error: { type: 'x', message: `bad key ${TEST_KEY}` } }));
    const result = await adapterWith(fetch).proposePlan({ apiKey: TEST_KEY, model: 'claude-opus-5-5', history: [], userContent: 'hi' });
    expect(result).toEqual({ ok: false, code });
  });

  it('the test setup blocks any real request to Anthropic', async () => {
    await expect(fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })).rejects.toThrow('Blocked in tests');
  });
});

describe('answers in the earlier format (status and due-date change lists)', () => {
  it('maps change lists to update actions; "" clears the due date', async () => {
    const { result } = await run([
      {
        ...planResponse(),
        content: [{ type: 'text', text: JSON.stringify({ reply: 'ok', question: '', tasks: [], statusChanges: [{ taskId: 't1', status: 'done' }], dueDateChanges: [{ taskId: 't2', dueDate: '2026-10-30' }, { taskId: 't3', dueDate: '' }] }) }],
      },
    ]);
    expect(result.plan.actions).toEqual([
      { type: 'update', taskId: 't1', changes: { status: 'done' } },
      { type: 'update', taskId: 't2', changes: { dueDate: '2026-10-30' } },
      { type: 'update', taskId: 't3', changes: { dueDate: null } },
    ]);
  });

  it.each([
    ['a non-array change list', { statusChanges: 'done' }],
    ['a change that is not an object', { dueDateChanges: ['t1'] }],
    ['too many changes', { statusChanges: Array.from({ length: 51 }, (_, i) => ({ taskId: `t${i}`, status: 'done' })) }],
  ])('rejects %s', async (_, extra) => {
    const { result } = await run([textResponse(JSON.stringify({ reply: '', question: '', tasks: [], statusChanges: [], dueDateChanges: [], ...extra }))]);
    expect(result).toEqual({ ok: false, code: 'MALFORMED' });
  });

  it('copies only taskId and status/dueDate; anything else in a change is dropped', () => {
    const plan = toPlan({ reply: '', question: '', tasks: [], statusChanges: [{ taskId: 't1', status: 'done', delete: true, title: 'x' }], dueDateChanges: [] });
    expect(plan.actions).toEqual([{ type: 'update', taskId: 't1', changes: { status: 'done' } }]);
  });
});

describe('the action list format', () => {
  // A wire action as the schema requires it: every field, "not applicable" values by default.
  const wire = (overrides = {}) => ({
    type: 'create', taskId: '', subtaskId: '', toTaskId: '', title: '', newTitle: '', description: '', status: 'unset', priority: 'unset', dueDate: '', dueTime: '',
    categoryId: '', newCategory: '', subtasks: [], labels: [], removeLabels: [], label: '', newLabel: '', reminders: [], recurrence: { freq: 'unset', interval: 0, weekdays: [], monthDay: 0 }, estimateMinutes: 0,
    done: 'unset', clear: [], filter: { status: 'unset', categoryId: '', priority: 'unset', due: 'unset', completedOlderThanDays: 0, titleContains: '', scope: 'unset' },
    operation: 'unset', date: '', items: [],
    ...overrides,
  });
  const plan = (...actions) => toPlan({ reply: 'ok', question: '', actions });

  it('create keeps only the fields that apply', () => {
    expect(plan(wire({ title: 'Подготовка к экзамену', description: 'Повторить ключевые темы', dueDate: '2026-10-30', dueTime: '16:30', priority: 'high', newCategory: 'Учёба', subtasks: ['Повторить ВВП', 'Изучить инфляцию'], reminders: [60], recurrence: { freq: 'weekly', interval: 1, weekdays: [5], monthDay: 0 }, estimateMinutes: 90 })).actions).toEqual([
      {
        type: 'create', title: 'Подготовка к экзамену', description: 'Повторить ключевые темы', dueDate: '2026-10-30', dueTime: '16:30', priority: 'high', newCategory: 'Учёба',
        subtasks: ['Повторить ВВП', 'Изучить инфляцию'], reminders: [60], recurrence: { freq: 'weekly', interval: 1, weekdays: [5] }, estimateMinutes: 90,
      },
    ]);
  });

  // Regression: "I've done everything" / "mark them as completed" showed renames. Strict output puts a
  // `title` on every action and models fill it with the existing task's title.
  it('completing: an update carrying the existing title (or a "done" variant) is a status change only, never a rename', () => {
    expect(plan(
      wire({ type: 'update', taskId: 'milk', title: 'Купить молоко', status: 'done' }),
      wire({ type: 'update', taskId: 'bread', title: 'Купить хлеб (выполнено)', status: 'done' }),
      wire({ type: 'update', taskId: 'report', title: 'Finish the report', status: 'done' }),
    ).actions).toEqual([
      { type: 'update', taskId: 'milk', changes: { status: 'done' } },
      { type: 'update', taskId: 'bread', changes: { status: 'done' } },
      { type: 'update', taskId: 'report', changes: { status: 'done' } },
    ]);
  });

  it('a rename is only an explicit newTitle', () => {
    expect(plan(wire({ type: 'update', taskId: 'milk', title: 'Купить молоко', newTitle: 'Купить молоко и сыр' })).actions).toEqual([
      { type: 'update', taskId: 'milk', changes: { title: 'Купить молоко и сыр' } },
    ]);
  });

  it('a bulk "mark all as completed" ignores a stray title (it used to make the whole action invalid)', () => {
    expect(plan(wire({ type: 'bulk', title: 'Все задачи', operation: 'update', status: 'done', filter: { status: 'todo', categoryId: '', priority: 'unset', due: 'unset', completedOlderThanDays: 0, titleContains: '' } })).actions).toEqual([
      { type: 'bulk', operation: 'update', filter: { status: 'todo' }, changes: { status: 'done' } },
    ]);
  });

  it('completing a subtask with its own title echoed is not a subtask rename', () => {
    expect(plan(wire({ type: 'updateSubtask', taskId: 't', subtaskId: 's', title: 'Повторить ВВП', done: 'true' })).actions).toEqual([
      { type: 'updateSubtask', taskId: 't', subtaskId: 's', done: true },
    ]);
    expect(plan(wire({ type: 'updateSubtask', taskId: 't', subtaskId: 's', newTitle: 'Повторить ВВП и ВНП' })).actions).toEqual([
      { type: 'updateSubtask', taskId: 't', subtaskId: 's', title: 'Повторить ВВП и ВНП' },
    ]);
  });

  it('"delete all tasks, including completed": filter scope "all" reaches the app; no criteria means no scope', () => {
    const filter = (overrides) => ({ ...wire().filter, ...overrides });
    expect(plan(wire({ type: 'bulk', operation: 'delete', filter: filter({ scope: 'all' }) })).actions).toEqual([
      { type: 'bulk', operation: 'delete', filter: { scope: 'all' }, changes: {} },
    ]);
    expect(plan(wire({ type: 'bulk', operation: 'delete', filter: filter({}) })).actions[0].filter).toEqual({});
    expect(SYSTEM_PROMPT).toContain('set filter scope "all"');
  });

  it('tags: labels name a new task\'s tags, and are tags to add for update and bulk', () => {
    expect(plan(wire({ title: 'Конспект', labels: ['учёба'] })).actions).toEqual([{ type: 'create', title: 'Конспект', labels: ['учёба'] }]);
    expect(plan(wire({ type: 'update', taskId: 'a', labels: ['срочно'] })).actions).toEqual([{ type: 'update', taskId: 'a', changes: { addLabels: ['срочно'] } }]);
    expect(plan(wire({ type: 'bulk', operation: 'update', labels: ['study'], filter: { ...wire().filter, categoryId: 'cat-study' } })).actions).toEqual([
      { type: 'bulk', operation: 'update', filter: { categoryId: 'cat-study' }, changes: { addLabels: ['study'] } },
    ]);
    expect(SYSTEM_PROMPT).toContain('tags to ADD');
  });

  it('tag management: remove from tasks, rename and delete a tag everywhere', () => {
    expect(plan(wire({ type: 'update', taskId: 'a', removeLabels: ['срочно'] })).actions).toEqual([{ type: 'update', taskId: 'a', changes: { removeLabels: ['срочно'] } }]);
    expect(plan(wire({ type: 'bulk', operation: 'update', removeLabels: ['old'], filter: { ...wire().filter, categoryId: 'cat-study' } })).actions).toEqual([
      { type: 'bulk', operation: 'update', filter: { categoryId: 'cat-study' }, changes: { removeLabels: ['old'] } },
    ]);
    expect(plan(wire({ type: 'renameLabel', label: 'учёба', newLabel: 'study' }), wire({ type: 'deleteLabel', label: 'срочно' })).actions).toEqual([
      { type: 'renameLabel', label: 'учёба', newLabel: 'study' },
      { type: 'deleteLabel', label: 'срочно' },
    ]);
    expect(SYSTEM_PROMPT).toContain('Delete a tag everywhere');
    expect(SYSTEM_PROMPT).toContain('Never use deleteLabel when the user names tasks');
  });

  it('the instructions say completing means status "done" and renaming needs newTitle', () => {
    expect(SYSTEM_PROMPT).toContain("I've done everything");
    expect(SYSTEM_PROMPT).toContain('mean status "done" for those tasks');
    expect(SYSTEM_PROMPT).toContain('Rename only with newTitle');
  });

  it('update: changed fields plus cleared ones ("remove the time but keep the date")', () => {
    expect(plan(wire({ type: 'update', taskId: 'exam', dueDate: '2026-10-30', clear: ['dueTime', 'reminders'] })).actions).toEqual([
      { type: 'update', taskId: 'exam', changes: { dueDate: '2026-10-30', dueTime: null, reminders: [] } },
    ]);
  });

  it('subtask actions, delete, bulk and schedule', () => {
    expect(
      plan(
        wire({ type: 'updateSubtask', taskId: 't', subtaskId: 's', done: 'true' }),
        wire({ type: 'moveSubtask', taskId: 't', subtaskId: 's2', toTaskId: 'u' }),
        wire({ type: 'delete', taskId: 'old' }),
        wire({ type: 'bulk', operation: 'update', dueDate: '2026-10-26', filter: { status: 'unset', categoryId: '', priority: 'unset', due: 'overdue', completedOlderThanDays: 0, titleContains: '' } }),
        wire({ type: 'schedule', date: '2026-10-26', items: [{ taskId: 't', start: '09:00' }] }),
      ).actions,
    ).toEqual([
      { type: 'updateSubtask', taskId: 't', subtaskId: 's', done: true },
      { type: 'moveSubtask', taskId: 't', subtaskId: 's2', toTaskId: 'u' },
      { type: 'delete', taskId: 'old' },
      { type: 'bulk', operation: 'update', filter: { due: 'overdue' }, changes: { dueDate: '2026-10-26' } },
      { type: 'schedule', date: '2026-10-26', items: [{ taskId: 't', start: '09:00' }] },
    ]);
  });

  it.each([
    ['an unknown action type', wire({ type: 'runCode' })],
    ['an unknown field to clear', wire({ type: 'update', taskId: 't', clear: ['id'] })],
    ['an action that is not an object', 'delete everything'],
  ])('rejects %s', (_, action) => {
    expect(plan(action)).toBeNull();
  });

  it('more than 50 actions are rejected', () => {
    expect(plan(...Array.from({ length: 51 }, () => wire({ title: 'x' })))).toBeNull();
  });
});
