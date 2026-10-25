// @vitest-environment node
// OpenAI, Google Gemini and OpenAI-compatible adapters (electron/ai/providers/*.cjs) with a
// scripted fake fetch - never the network: connection tests, request shapes, structured output,
// response normalization into the action-plan format, refusals, truncation, malformed answers,
// error mapping and history handling.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createFakeFetch, json } from '../helpers/fakeFetch.js';

const require = createRequire(import.meta.url);
const { createOpenAiAdapter, MAX_OUTPUT_TOKENS } = require('../../electron/ai/providers/openai.cjs');
const { createGeminiAdapter, RESPONSE_SCHEMA_GEMINI } = require('../../electron/ai/providers/gemini.cjs');
const { createOpenAiCompatibleAdapter } = require('../../electron/ai/providers/openaiCompatible.cjs');
const { RESPONSE_SCHEMA } = require('../../electron/ai/providers/shared.cjs');
const { SYSTEM_PROMPT } = require('../../electron/ai/prompt.cjs');

const OPENAI_KEY = 'sk-proj-test-0123456789abcdefghijklmn';
const GEMINI_KEY = 'AIzaTest0123456789abcdefghijklmnopqrs';
const OTHER_KEY = 'local-test-token-123';
const BASE_URL = 'https://llm.example.test/v1';
const answer = (overrides = {}) => JSON.stringify({ reply: 'ok', question: '', tasks: [], statusChanges: [], dueDateChanges: [], ...overrides });
const newTask = (title, extra = {}) => ({ title, dueDate: '', priority: 'medium', categoryId: '', subtasks: [], ...extra });
const errorBody = (status) => json({ error: { message: `bad ${OPENAI_KEY} ${GEMINI_KEY}`, code: 'x' } }, status);

// ---------------------------------------------------------------- OpenAI (Responses API)
const openAiResponse = (text, overrides = {}) => ({
  id: 'resp_test',
  object: 'response',
  status: 'completed',
  output: [
    { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'opaque' },
    { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
  ],
  ...overrides,
});

describe('OpenAI adapter', () => {
  const adapter = (script) => {
    const fake = createFakeFetch(script);
    return { fake, adapter: createOpenAiAdapter({ fetch: fake.fetch }) };
  };

  it('connection test: one GET /v1/models/{model} with the key as a bearer token, no body, no redirects', async () => {
    const { fake, adapter: openai } = adapter([json({ id: 'gpt-6-astra', object: 'model', created: 1, owned_by: 'openai' })]);
    expect(await openai.testConnection({ apiKey: OPENAI_KEY, model: 'gpt-6-astra' })).toEqual({ ok: true });
    expect(fake.calls).toEqual([{ url: 'https://api.openai.com/v1/models/gpt-6-astra', method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${OPENAI_KEY}` }, body: undefined, redirect: 'error' }]);
  });

  it.each([
    [401, 'AUTH'],
    [403, 'PERMISSION'],
    [404, 'MODEL_UNAVAILABLE'],
    [429, 'RATE_LIMIT'],
    [500, 'PROVIDER_ERROR'],
    [503, 'OVERLOADED'],
  ])('connection test: HTTP %s -> %s, without any response text', async (status, code) => {
    const { adapter: openai } = adapter([errorBody(status)]);
    expect(await openai.testConnection({ apiKey: OPENAI_KEY, model: 'gpt-6-astra' })).toEqual({ ok: false, code });
  });

  it.each([
    ['a network failure', new TypeError('fetch failed'), 'NETWORK'],
    ['not JSON', { status: 200, body: '<html>' }, 'MALFORMED'],
    ['another object', json({ object: 'list', data: [] }), 'MALFORMED'],
  ])('connection test: %s -> %s', async (_, reply, code) => {
    const { adapter: openai } = adapter([reply]);
    expect(await openai.testConnection({ apiKey: OPENAI_KEY, model: 'gpt-6-astra' })).toEqual({ ok: false, code });
  });

  it('a request that never answers times out', async () => {
    const hang = (call, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const fake = createFakeFetch([hang]);
    const { requestJson } = require('../../electron/ai/providers/shared.cjs');
    expect(await requestJson({ fetch: fake.fetch, url: 'https://api.openai.com/v1/models/x', timeoutMs: 20 })).toEqual({ ok: false, code: 'TIMEOUT' });
  });

  it('proposals: POST /v1/responses with instructions, strict json_schema, low effort, not stored', async () => {
    const { fake, adapter: openai } = adapter([json(openAiResponse(answer({ reply: 'Создам', tasks: [newTask('Купить молоко', { dueDate: '2026-10-25' })] })))]);
    const result = await openai.proposePlan({ apiKey: OPENAI_KEY, model: 'gpt-6-astra', history: [], userContent: 'App context...\n\nUser message:\nМолоко завтра' });
    expect(result).toMatchObject({ ok: true, plan: { reply: 'Создам', question: '', actions: [{ type: 'create', title: 'Купить молоко', dueDate: '2026-10-25' }] } });
    const [call] = fake.calls;
    expect(call.url).toBe('https://api.openai.com/v1/responses');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(call.body).toEqual({
      model: 'gpt-6-astra',
      instructions: SYSTEM_PROMPT,
      input: [{ role: 'user', content: 'App context...\n\nUser message:\nМолоко завтра' }],
      text: { format: { type: 'json_schema', name: 'taskflow_plan', schema: RESPONSE_SCHEMA, strict: true } },
      reasoning: { effort: 'low' },
      max_output_tokens: MAX_OUTPUT_TOKENS,
      store: false,
    });
  });

  it('history: every output item (reasoning included) is replayed unchanged, then only appended to', async () => {
    const first = openAiResponse(answer({ question: 'Когда?' }));
    const { fake, adapter: openai } = adapter([json(first), json(openAiResponse(answer()))]);
    const one = await openai.proposePlan({ apiKey: OPENAI_KEY, model: 'gpt-6-astra', history: [], userContent: 'A' });
    expect(one.turn).toEqual([{ role: 'user', content: 'A' }, ...first.output]);
    await openai.proposePlan({ apiKey: OPENAI_KEY, model: 'gpt-6-astra', history: one.turn, userContent: 'B' });
    expect(fake.calls[1].body.input).toEqual([...one.turn, { role: 'user', content: 'B' }]);
  });

  it.each([
    ['a refusal part', openAiResponse('', { output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No.' }] }] }), 'REFUSED'],
    ['an incomplete answer (token limit)', openAiResponse('{"reply":"', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'TRUNCATED'],
    ['an incomplete answer (content filter)', openAiResponse('', { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }), 'REFUSED'],
    ['a failed response', openAiResponse('', { status: 'failed' }), 'MALFORMED'],
    ['no output list', { status: 'completed' }, 'MALFORMED'],
    ['text that is not JSON', openAiResponse('Sure! Here are your tasks.'), 'MALFORMED'],
    ['JSON of the wrong shape', openAiResponse('{"tasks":"many"}'), 'MALFORMED'],
  ])('%s -> %s', async (_, response, code) => {
    const { adapter: openai } = adapter([json(response)]);
    expect(await openai.proposePlan({ apiKey: OPENAI_KEY, model: 'gpt-6-astra', history: [], userContent: 'x' })).toEqual({ ok: false, code });
  });
});

// ---------------------------------------------------------------- Google Gemini (generateContent)
const geminiResponse = (text, overrides = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text, thoughtSignature: 'c2lnbmF0dXJl' }] }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  ...overrides,
});

describe('Gemini adapter', () => {
  const adapter = (script) => {
    const fake = createFakeFetch(script);
    return { fake, adapter: createGeminiAdapter({ fetch: fake.fetch }) };
  };

  it('connection test: one GET models.get with the key in the x-goog-api-key header (never in the URL)', async () => {
    const { fake, adapter: gemini } = adapter([json({ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] })]);
    expect(await gemini.testConnection({ apiKey: GEMINI_KEY, model: 'gemini-3.8-flash' })).toEqual({ ok: true });
    expect(fake.calls).toEqual([{ url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash', method: 'GET', headers: { accept: 'application/json', 'x-goog-api-key': GEMINI_KEY }, body: undefined, redirect: 'error' }]);
    expect(fake.calls[0].url).not.toContain(GEMINI_KEY);
  });

  it.each([
    [400, 'AUTH'],
    [401, 'AUTH'],
    [403, 'PERMISSION'],
    [404, 'MODEL_UNAVAILABLE'],
    [429, 'RATE_LIMIT'],
    [503, 'OVERLOADED'],
  ])('connection test: HTTP %s -> %s', async (status, code) => {
    const { adapter: gemini } = adapter([errorBody(status)]);
    expect(await gemini.testConnection({ apiKey: GEMINI_KEY, model: 'gemini-3.8-flash' })).toEqual({ ok: false, code });
  });

  it('connection test: a model that cannot generate content, or an unexpected answer, is not success', async () => {
    const { adapter: gemini } = adapter([json({ name: 'models/x', supportedGenerationMethods: ['embedContent'] }), json({ models: [] })]);
    expect(await gemini.testConnection({ apiKey: GEMINI_KEY, model: 'x' })).toEqual({ ok: false, code: 'MODEL_UNAVAILABLE' });
    expect(await gemini.testConnection({ apiKey: GEMINI_KEY, model: 'x' })).toEqual({ ok: false, code: 'MALFORMED' });
  });

  it('proposals: POST :generateContent with system instruction and a response schema in Gemini format', async () => {
    const { fake, adapter: gemini } = adapter([json(geminiResponse(answer({ statusChanges: [{ taskId: 't1', status: 'done' }] })))]);
    const result = await gemini.proposePlan({ apiKey: GEMINI_KEY, model: 'gemini-3.8-flash', history: [], userContent: 'Отчёт готов' });
    expect(result).toMatchObject({ ok: true, plan: { actions: [{ type: 'update', taskId: 't1', changes: { status: 'done' } }] } });
    const [call] = fake.calls;
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(call.headers['x-goog-api-key']).toBe(GEMINI_KEY);
    expect(call.body.systemInstruction).toEqual({ parts: [{ text: SYSTEM_PROMPT }] });
    expect(call.body.contents).toEqual([{ role: 'user', parts: [{ text: 'Отчёт готов' }] }]);
    expect(call.body.generationConfig).toMatchObject({ responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA_GEMINI });
  });

  it('the Gemini schema mirrors the app schema: upper-case types, same fields, required and enums, no additionalProperties', () => {
    expect(RESPONSE_SCHEMA_GEMINI.type).toBe('OBJECT');
    expect(RESPONSE_SCHEMA_GEMINI.required).toEqual(RESPONSE_SCHEMA.required);
    expect(RESPONSE_SCHEMA_GEMINI.propertyOrdering).toEqual(Object.keys(RESPONSE_SCHEMA.properties));
    expect(RESPONSE_SCHEMA_GEMINI.properties.actions.items.properties.priority).toEqual({ type: 'STRING', enum: ['unset', 'low', 'medium', 'high'] });
    expect(RESPONSE_SCHEMA_GEMINI.properties.actions.items.properties.recurrence.properties.interval).toEqual({ type: 'INTEGER' });
    expect(JSON.stringify(RESPONSE_SCHEMA_GEMINI)).not.toContain('additionalProperties');
  });

  it('history: model turns are replayed with their parts unchanged (thought signatures kept); thought parts are not the answer', async () => {
    const first = geminiResponse(answer({ reply: 'final' }));
    first.candidates[0].content.parts.unshift({ text: 'thinking out loud', thought: true });
    const { fake, adapter: gemini } = adapter([json(first), json(geminiResponse(answer()))]);
    const one = await gemini.proposePlan({ apiKey: GEMINI_KEY, model: 'gemini-3.8-flash', history: [], userContent: 'A' });
    expect(one.plan.reply).toBe('final');
    expect(one.turn[1]).toEqual({ role: 'model', parts: first.candidates[0].content.parts });
    await gemini.proposePlan({ apiKey: GEMINI_KEY, model: 'gemini-3.8-flash', history: one.turn, userContent: 'B' });
    expect(fake.calls[1].body.contents).toEqual([...one.turn, { role: 'user', parts: [{ text: 'B' }] }]);
  });

  it.each([
    ['a blocked prompt', { promptFeedback: { blockReason: 'SAFETY' } }, 'REFUSED'],
    ['a safety stop', geminiResponse('', { candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }), 'REFUSED'],
    ['the token limit', geminiResponse('{"reply":', { candidates: [{ content: { parts: [{ text: '{' }] }, finishReason: 'MAX_TOKENS' }] }), 'TRUNCATED'],
    ['no candidates', { candidates: [] }, 'MALFORMED'],
    ['no parts', { candidates: [{ finishReason: 'STOP' }] }, 'MALFORMED'],
    ['text that is not JSON', geminiResponse('Конечно!'), 'MALFORMED'],
  ])('%s -> %s', async (_, response, code) => {
    const { adapter: gemini } = adapter([json(response)]);
    expect(await gemini.proposePlan({ apiKey: GEMINI_KEY, model: 'gemini-3.8-flash', history: [], userContent: 'x' })).toEqual({ ok: false, code });
  });
});

// ---------------------------------------------------------------- OpenAI-compatible (Chat Completions)
const chatResponse = (content, overrides = {}) => ({ choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop' }], ...overrides });

describe('OpenAI-compatible adapter', () => {
  const adapter = (script) => {
    const fake = createFakeFetch(script);
    return { fake, adapter: createOpenAiCompatibleAdapter({ fetch: fake.fetch }) };
  };

  it('connection test: GET {baseUrl}/models; the configured model must be listed', async () => {
    const { fake, adapter: compatible } = adapter([json({ object: 'list', data: [{ id: 'local-model', object: 'model' }] }), json({ object: 'list', data: [{ id: 'other' }] })]);
    expect(await compatible.testConnection({ apiKey: OTHER_KEY, model: 'local-model', baseUrl: BASE_URL })).toEqual({ ok: true });
    expect(fake.calls[0]).toMatchObject({ url: `${BASE_URL}/models`, method: 'GET', headers: { authorization: `Bearer ${OTHER_KEY}` }, redirect: 'error' });
    expect(await compatible.testConnection({ apiKey: OTHER_KEY, model: 'local-model', baseUrl: BASE_URL })).toEqual({ ok: false, code: 'MODEL_UNAVAILABLE' });
  });

  it('connection test: no API at the address (404), a rejected key and an unexpected answer fail', async () => {
    const { adapter: compatible } = adapter([errorBody(404), errorBody(401), json({ models: [] })]);
    expect(await compatible.testConnection({ apiKey: OTHER_KEY, model: 'm', baseUrl: BASE_URL })).toEqual({ ok: false, code: 'ENDPOINT_NOT_FOUND' });
    expect(await compatible.testConnection({ apiKey: OTHER_KEY, model: 'm', baseUrl: BASE_URL })).toEqual({ ok: false, code: 'AUTH' });
    expect(await compatible.testConnection({ apiKey: OTHER_KEY, model: 'm', baseUrl: BASE_URL })).toEqual({ ok: false, code: 'MALFORMED' });
  });

  it('proposals: POST {baseUrl}/chat/completions with the system prompt, a JSON hint and json_schema', async () => {
    const { fake, adapter: compatible } = adapter([json(chatResponse(answer({ dueDateChanges: [{ taskId: 't1', dueDate: '' }] })))]);
    const result = await compatible.proposePlan({ apiKey: OTHER_KEY, model: 'local-model', baseUrl: BASE_URL, history: [], userContent: 'убери срок' });
    expect(result).toMatchObject({ ok: true, plan: { actions: [{ type: 'update', taskId: 't1', changes: { dueDate: null } }] }, turn: [{ role: 'user', content: 'убери срок' }, { role: 'assistant' }] });
    const [call] = fake.calls;
    expect(call.url).toBe(`${BASE_URL}/chat/completions`);
    expect(call.body.model).toBe('local-model');
    expect(call.body.messages[0].role).toBe('system');
    expect(call.body.messages[0].content.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(call.body.messages.at(-1)).toEqual({ role: 'user', content: 'убери срок' });
    expect(call.body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'taskflow_plan', schema: RESPONSE_SCHEMA, strict: true } });
  });

  it.each([
    ['a refusal', chatResponse(null, { choices: [{ message: { content: null, refusal: 'No.' }, finish_reason: 'stop' }] }), 'REFUSED'],
    ['a content filter stop', chatResponse('', { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }), 'REFUSED'],
    ['the length limit', chatResponse('{"reply":', { choices: [{ message: { content: '{' }, finish_reason: 'length' }] }), 'TRUNCATED'],
    ['no choices', { choices: [] }, 'MALFORMED'],
    ['text that is not JSON', chatResponse('Here you go'), 'MALFORMED'],
  ])('%s -> %s', async (_, response, code) => {
    const { adapter: compatible } = adapter([json(response)]);
    expect(await compatible.proposePlan({ apiKey: OTHER_KEY, model: 'm', baseUrl: BASE_URL, history: [], userContent: 'x' })).toEqual({ ok: false, code });
  });
});

describe('every adapter', () => {
  it('error results never carry response text or keys', async () => {
    const results = [
      await createOpenAiAdapter({ fetch: createFakeFetch([errorBody(401)]).fetch }).proposePlan({ apiKey: OPENAI_KEY, model: 'm', history: [], userContent: 'x' }),
      await createGeminiAdapter({ fetch: createFakeFetch([errorBody(401)]).fetch }).proposePlan({ apiKey: GEMINI_KEY, model: 'm', history: [], userContent: 'x' }),
      await createOpenAiCompatibleAdapter({ fetch: createFakeFetch([errorBody(401)]).fetch }).proposePlan({ apiKey: OTHER_KEY, model: 'm', baseUrl: BASE_URL, history: [], userContent: 'x' }),
    ];
    expect(results).toEqual([{ ok: false, code: 'AUTH' }, { ok: false, code: 'AUTH' }, { ok: false, code: 'AUTH' }]);
  });

  it('the test setup blocks real requests to OpenAI and Google', async () => {
    await expect(fetch('https://api.openai.com/v1/models')).rejects.toThrow('Blocked in tests');
    await expect(fetch('https://generativelanguage.googleapis.com/v1beta/models')).rejects.toThrow('Blocked in tests');
  });
});
