// AI connection settings through the real app, backed by the real main-process settings store,
// connection and IPC handlers (fake safeStorage, fake Anthropic client, temp folder). No network.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAnthropic, modelInfo } from '../helpers/fakeAnthropic.js';
import { createFakeFetch, json } from '../helpers/fakeFetch.js';
import { createFakeSafeStorage, OTHER_TEST_KEY, TEST_KEY } from '../helpers/fakeSafeStorage.js';
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

const require = createRequire(import.meta.url);
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default ?? sdk;
const AI_FILE = 'taskflow-ai.json';
const httpError = (status) => Object.assign(new Error(`HTTP ${status} ${TEST_KEY}`), { status });
// `script` answers the Anthropic SDK; `http` answers fetch (OpenAI, Gemini, compatible APIs).
const start = (script = [], options = {}, http = []) =>
  renderApp({ document: makeDocument({ tasks: [makeTask({ id: 'a', title: 'Существующая задача' })] }), anthropic: createFakeAnthropic(script), web: createFakeFetch(http), ...options });
const advanced = (dialog) => dialog.querySelector('details.ai-settings__advanced');
// Text of the default connection view: everything except the advanced and voice input sections.
const defaultViewText = (dialog) => {
  const copy = dialog.cloneNode(true);
  copy.querySelector('details.ai-settings__advanced')?.remove();
  // Voice input names OpenAI on purpose: it needs an OpenAI key.
  copy.querySelector('.ai-settings__voice')?.remove();
  return copy.textContent;
};
const openSettings = async () => {
  // The header button opens the assistant panel; AI settings open from there.
  await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
  await env.user.click(within(screen.getByRole('complementary', { name: 'ИИ-помощник' })).getByRole('button', { name: 'Настройки ИИ' }));
  const dialog = screen.getByRole('dialog', { name: 'ИИ-помощник' });
  await within(dialog).findByLabelText('API-ключ');
  return dialog;
};
const keyInput = (dialog) => within(dialog).getByLabelText('API-ключ');
const toggle = (dialog) => within(dialog).queryByRole('checkbox', { name: 'Включить ИИ-помощника' });
const status = (dialog) => dialog.querySelector('.ai-settings__status');
const aiFile = () => env.temp.readJson(AI_FILE);
const connectWith = async (dialog, key, button = 'Подключить') => {
  if (key) await env.user.type(keyInput(dialog), key);
  await env.user.click(within(dialog).getByRole('button', { name: button }));
};

describe('AI connection settings', () => {
  it('opens disconnected: only a key field, Connect and a status - no provider, model or on/off', async () => {
    env = await start();
    const dialog = await openSettings();
    expect(status(dialog)).toHaveTextContent('Не подключено');
    expect(keyInput(dialog)).toHaveAttribute('type', 'password');
    expect(keyInput(dialog)).toHaveAttribute('autocomplete', 'off');
    expect(within(dialog).getByRole('button', { name: 'Подключить' })).toBeInTheDocument();
    expect(toggle(dialog)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Отключить и удалить ключ' })).not.toBeInTheDocument();
    // Provider choice and the OpenAI-compatible fields live only in the collapsed advanced section.
    expect(advanced(dialog).open).toBe(false);
    expect(advanced(dialog).querySelector('summary')).toHaveTextContent('Дополнительно');
    expect(defaultViewText(dialog)).not.toMatch(/anthropic|claude|openai|gpt|gemini|google|sk-ant/i);
    expect(within(dialog).queryByLabelText('Адрес API (base URL)')).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent('Описания и остальные задачи не отправляются');
    expect(env.temp.list()).not.toContain(AI_FILE);
    expect(env.anthropic.clients).toHaveLength(0);
  });

  it('Connect: tests the key, then stores it encrypted, clears the field, says "Подключено" and turns AI on', async () => {
    env = await start([modelInfo()]);
    const dialog = await openSettings();
    await connectWith(dialog, TEST_KEY);
    await within(dialog).findByText('Подключено. Ключ сохранён в зашифрованном виде, помощник включён.');
    expect(status(dialog)).toHaveTextContent('Подключено');
    expect(keyInput(dialog)).toHaveValue('');
    expect(toggle(dialog)).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Переподключить' })).toBeInTheDocument();
    // One test request (no messages, no tasks).
    expect(env.anthropic.modelRequests).toHaveLength(1);
    expect(env.anthropic.requests).toHaveLength(0);
    // The key is nowhere in the page, in the renderer API's answers or in the file as text.
    expect(document.body.innerHTML).not.toContain(TEST_KEY);
    expect(JSON.stringify(await window.taskflow.ai.getSettings())).not.toContain('sk-ant');
    expect(fs.readFileSync(env.temp.file(AI_FILE), 'utf8')).not.toContain(TEST_KEY);
    expect(Object.keys(window.taskflow.ai).sort()).toEqual(['chat', 'connect', 'connectSpeech', 'disconnect', 'getSettings', 'resetChat', 'saveSettings', 'transcribe']);
  });

  it.each([
    ['a rejected key', httpError(401), 'Ключ не принят'],
    ['a network error', new Anthropic.APIConnectionError({ message: 'offline' }), 'Нет связи с сервисом'],
    ['a timeout', new Anthropic.APIConnectionTimeoutError(), 'Сервис не ответил вовремя'],
    ['a rate limit', httpError(429), 'Слишком много запросов'],
    ['an outage', httpError(500), 'Сервис сейчас недоступен'],
  ])('%s: "Не удалось подключиться", nothing stored, AI stays off', async (_, failure, reason) => {
    env = await start([failure]);
    const dialog = await openSettings();
    await connectWith(dialog, TEST_KEY);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось подключиться.');
    expect(alert).toHaveTextContent(reason);
    expect(alert.textContent).not.toContain(TEST_KEY);
    expect(status(dialog)).toHaveTextContent('Не подключено');
    expect(toggle(dialog)).not.toBeInTheDocument();
    expect(keyInput(dialog)).toHaveValue('');
    expect(keyInput(dialog)).toHaveFocus();
    expect(keyInput(dialog)).toHaveAttribute('aria-invalid', 'true');
    expect(env.temp.list()).not.toContain(AI_FILE);
  });

  it('a key whose service cannot be identified is not sent anywhere; the advanced choice then connects it', async () => {
    env = await start([], {}, [json({ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] })]);
    const dialog = await openSettings();
    await connectWith(dialog, null);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Вставьте API-ключ.');
    expect(keyInput(dialog)).toHaveFocus();
    const unknownKey = 'AQ.new-style-test-key-0123456789abcdef';
    await connectWith(dialog, unknownKey);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось определить сервис по ключу. Выберите сервис в разделе «Дополнительно».');
    expect(env.anthropic.clients).toHaveLength(0);
    expect(env.web.calls).toHaveLength(0);
    expect(env.temp.list()).not.toContain(AI_FILE);
    // The advanced section opens with the service choice.
    await waitFor(() => expect(advanced(dialog).open).toBe(true));
    await env.user.selectOptions(within(dialog).getByRole('combobox', { name: 'Сервис' }), 'Google Gemini');
    await connectWith(dialog, unknownKey);
    await within(dialog).findByText(/^Подключено\. Ключ сохранён/);
    expect(env.web.calls).toHaveLength(1);
    expect(env.web.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash');
    expect(advanced(dialog)).toHaveTextContent('Ключ относится к сервису: Google Gemini (gemini-3.8-flash).');
    expect(document.body.innerHTML).not.toContain(unknownKey);
  });

  it('an OpenAI key is recognized and connected without choosing anything', async () => {
    env = await start([], {}, [json({ id: 'gpt-6-luna', object: 'model', created: 1, owned_by: 'openai' })]);
    const dialog = await openSettings();
    await connectWith(dialog, 'sk-proj-test-0123456789abcdefghijklmn');
    await within(dialog).findByText(/^Подключено\. Ключ сохранён/);
    expect(env.web.calls.map((call) => call.url)).toEqual(['https://api.openai.com/v1/models/gpt-6-luna']);
    expect(env.anthropic.clients).toHaveLength(0);
    expect(defaultViewText(dialog)).not.toMatch(/openai|gpt/i);
  });

  it('OpenAI-compatible API: address and model in the advanced section; a bad address sends nothing; a saved configuration is shown again', async () => {
    env = await start([], {}, [json({ object: 'list', data: [{ id: 'local-model' }] })]);
    let dialog = await openSettings();
    await env.user.click(advanced(dialog).querySelector('summary'));
    await env.user.selectOptions(within(dialog).getByRole('combobox', { name: 'Сервис' }), 'OpenAI-совместимый API');
    await env.user.type(within(dialog).getByLabelText('Адрес API (base URL)'), 'http://llm.example.test/v1');
    await env.user.type(within(dialog).getByLabelText('ID модели'), 'local-model');
    await connectWith(dialog, 'local-token');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('начинается с https://');
    expect(env.web.calls).toHaveLength(0);
    await env.user.clear(within(dialog).getByLabelText('Адрес API (base URL)'));
    await env.user.type(within(dialog).getByLabelText('Адрес API (base URL)'), 'https://llm.example.test/v1');
    await connectWith(dialog, 'local-token');
    await within(dialog).findByText(/^Подключено\. Ключ сохранён/);
    expect(env.web.calls.map((call) => call.url)).toEqual(['https://llm.example.test/v1/models']);
    expect(aiFile().compatible).toEqual({ baseUrl: 'https://llm.example.test/v1', model: 'local-model' });
    await env.user.keyboard('{Escape}');
    // The panel is still open: reopen the settings from it.
    await env.user.click(within(screen.getByRole('complementary', { name: 'ИИ-помощник' })).getByRole('button', { name: 'Настройки ИИ' }));
    dialog = screen.getByRole('dialog', { name: 'ИИ-помощник' });
    await within(dialog).findByLabelText('API-ключ');
    await env.user.click(advanced(dialog).querySelector('summary'));
    await env.user.selectOptions(within(dialog).getByRole('combobox', { name: 'Сервис' }), 'OpenAI-совместимый API');
    expect(within(dialog).getByLabelText('Адрес API (base URL)')).toHaveValue('https://llm.example.test/v1');
    expect(within(dialog).getByLabelText('ID модели')).toHaveValue('local-model');
    expect(advanced(dialog)).toHaveTextContent('OpenAI-совместимый API (https://llm.example.test/v1, local-model)');
  });

  it('a failed replacement key keeps the working one and says so', async () => {
    env = await start([modelInfo(), httpError(401)]);
    const dialog = await openSettings();
    await connectWith(dialog, TEST_KEY);
    await within(dialog).findByText(/^Подключено\. Ключ сохранён/);
    const before = aiFile().credentials;
    await connectWith(dialog, OTHER_TEST_KEY, 'Переподключить');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось подключиться. Ключ не принят');
    expect(alert).toHaveTextContent('Прежний ключ сохранён и по-прежнему используется.');
    expect(status(dialog)).toHaveTextContent('Подключено');
    expect(toggle(dialog)).toBeChecked();
    expect(aiFile().credentials).toEqual(before);
  });

  it('after a restart a stored key is "Ключ сохранён", not "Подключено", until Reconnect checks it', async () => {
    env = await start([modelInfo()]);
    let dialog = await openSettings();
    await connectWith(dialog, TEST_KEY);
    await within(dialog).findByText(/^Подключено\. Ключ сохранён/);
    env.unmount();
    env = await renderApp({ temp: env.temp, anthropic: createFakeAnthropic([modelInfo()]) });
    dialog = await openSettings();
    expect(status(dialog)).toHaveTextContent('Ключ сохранён');
    expect(status(dialog)).not.toHaveTextContent('Подключено');
    expect(status(dialog)).toHaveTextContent('Последняя успешная проверка');
    expect(status(dialog)).toHaveTextContent('В этом сеансе подключение ещё не проверялось.');
    expect(env.anthropic.clients).toHaveLength(0); // nothing is checked automatically
    expect(toggle(dialog)).toBeChecked();
    // Reconnect with an empty field checks the stored key again.
    await connectWith(dialog, null, 'Переподключить');
    await within(dialog).findByText('Подключение проверено.');
    expect(status(dialog)).toHaveTextContent('Подключено');
    expect(env.anthropic.modelRequests).toHaveLength(1);
  });

  it('switching off and on, and Disconnect removes the key and turns AI off', async () => {
    env = await start([modelInfo()]);
    const dialog = await openSettings();
    await connectWith(dialog, TEST_KEY);
    await waitFor(() => expect(toggle(dialog)).toBeChecked());
    await env.user.click(toggle(dialog));
    await waitFor(() => expect(aiFile()).toMatchObject({ enabled: false }));
    await env.user.click(toggle(dialog));
    await waitFor(() => expect(aiFile()).toMatchObject({ enabled: true }));
    await env.user.click(within(dialog).getByRole('button', { name: 'Отключить и удалить ключ' }));
    await within(dialog).findByText('Отключено. Ключ удалён, помощник выключен.');
    expect(status(dialog)).toHaveTextContent('Не подключено');
    expect(toggle(dialog)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Подключить' })).toBeInTheDocument();
    expect(aiFile()).toMatchObject({ enabled: false, verifiedAt: null, credentials: {} });
  });

  it('without secure storage it explains why and offers no key field', async () => {
    env = await start([], { safeStorage: createFakeSafeStorage({ available: false }) });
    await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
    await env.user.click(within(screen.getByRole('complementary', { name: 'ИИ-помощник' })).getByRole('button', { name: 'Настройки ИИ' }));
    const dialog = screen.getByRole('dialog', { name: 'ИИ-помощник' });
    await within(dialog).findByText(/Защищённое хранилище Windows недоступно/);
    expect(within(dialog).queryByLabelText('API-ключ')).not.toBeInTheDocument();
    expect(toggle(dialog)).not.toBeInTheDocument();
  });

  it('a corrupt settings file opens with safe defaults (AI off)', async () => {
    env = await start();
    env.temp.writeText(AI_FILE, '{"enabled": true, ');
    const dialog = await openSettings();
    expect(status(dialog)).toHaveTextContent('Не подключено');
    expect(toggle(dialog)).not.toBeInTheDocument();
    expect(env.temp.list().some((name) => name.startsWith('taskflow-ai.unreadable-'))).toBe(true);
  });

  it('closes with Escape and returns focus to the panel’s AI settings button; tasks are untouched', async () => {
    env = await start([modelInfo()]);
    await waitFor(() => expect(env.readData().tasks).toHaveLength(1));
    const before = JSON.stringify(env.readData());
    const dialog = await openSettings();
    await connectWith(dialog, TEST_KEY);
    await within(dialog).findByText(/^Подключено\. Ключ сохранён/);
    await env.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(screen.getByRole('complementary', { name: 'ИИ-помощник' })).getByRole('button', { name: 'Настройки ИИ' })).toHaveFocus();
    expect(JSON.stringify(env.readData())).toBe(before);
    expect(screen.getByRole('heading', { level: 3, name: 'Существующая задача' })).toBeInTheDocument();
  });

  it('works in English', async () => {
    env = await start([httpError(401)]);
    await env.user.click(screen.getByRole('radio', { name: 'EN' }));
    await env.user.click(screen.getByRole('button', { name: 'AI assistant' }));
    await env.user.click(within(screen.getByRole('complementary', { name: 'AI assistant' })).getByRole('button', { name: 'AI settings' }));
    const dialog = screen.getByRole('dialog', { name: 'AI assistant' });
    await within(dialog).findByLabelText('API key');
    expect(status(dialog)).toHaveTextContent('Not connected');
    await env.user.type(within(dialog).getByLabelText('API key'), TEST_KEY);
    await env.user.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Connection failed. The key was not accepted');
  });
});
