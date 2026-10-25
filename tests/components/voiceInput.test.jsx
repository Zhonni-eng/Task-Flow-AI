// Voice input through the real app: microphone button -> recording -> transcription (real IPC and
// main-process speech service; OpenAI answered by a scripted fake fetch) -> text inserted into the
// message box. Never sent automatically. The microphone itself is simulated (jsdom has none).
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertAtSelection } from '../../src/ai/useVoiceInput.js';
import { createFakeAnthropic, modelInfo } from '../helpers/fakeAnthropic.js';
import { createFakeFetch, json } from '../helpers/fakeFetch.js';
import { TEST_KEY } from '../helpers/fakeSafeStorage.js';
import { makeDocument, makeTask } from '../helpers/fixtures.js';
import { renderApp } from '../helpers/renderApp.jsx';

const OPENAI_KEY = 'sk-proj-voice-0123456789abcdefghijklmn';
let env;
let micAccess;
let recorders;
let stoppedTracks;

class FakeRecorder extends EventTarget {
  static isTypeSupported = (type) => type.startsWith('audio/webm');
  constructor(stream, options) {
    super();
    this.mimeType = options?.mimeType ?? 'audio/webm';
    this.state = 'inactive';
    this.bytes = 5000;
    recorders.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    const data = new Event('dataavailable');
    data.data = new Blob([new Uint8Array(this.bytes).fill(1)], { type: 'audio/webm' });
    this.dispatchEvent(data);
    this.dispatchEvent(new Event('stop'));
  }
}

beforeEach(() => {
  recorders = [];
  stoppedTracks = 0;
  micAccess = vi.fn(async () => ({ getTracks: () => [{ stop: () => (stoppedTracks += 1) }] }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: micAccess } });
  globalThis.MediaRecorder = FakeRecorder;
});
afterEach(() => {
  env?.temp.remove();
  delete globalThis.MediaRecorder;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** App with the assistant on OpenAI (model check first), then the given transcription answers. */
const start = async (transcriptions = [], { provider = 'openai' } = {}) => {
  const web = createFakeFetch(provider === 'openai' ? [json({ id: 'gpt-6-luna', object: 'model', created: 1, owned_by: 'openai' }), ...transcriptions] : transcriptions);
  const anthropic = createFakeAnthropic(provider === 'anthropic' ? [modelInfo()] : []);
  env = await renderApp({ document: makeDocument({ tasks: [makeTask({ id: 'a', title: 'Задача' })] }), web, anthropic });
  await window.taskflow.ai.connect({ key: provider === 'openai' ? OPENAI_KEY : TEST_KEY });
  await env.user.click(screen.getByRole('button', { name: 'ИИ-помощник' }));
  await waitFor(() => expect(box()).toBeEnabled());
};
const panel = () => screen.getByRole('complementary', { name: 'ИИ-помощник' });
const box = () => within(panel()).getByRole('textbox', { name: 'Сообщение помощнику' });
const mic = () => within(panel()).getByRole('button', { name: /Голосовой ввод: начать запись|Остановить запись/ });
const record = async (ms = 450) => {
  await env.user.click(mic());
  await within(panel()).findByText(/Идёт запись/);
  await sleep(ms);
  await env.user.click(mic());
};
const transcriptionCalls = () => env.web.calls.filter((call) => call.url.endsWith('/audio/transcriptions'));

describe('voice input', () => {
  it('inserts the recognized text into the message box after the text already there - and sends nothing', async () => {
    await start([json({ text: 'и молоко на завтра' })]);
    await env.user.type(box(), 'Купить хлеб');
    expect(mic()).toHaveAttribute('aria-pressed', 'false');
    await env.user.click(mic());
    expect(await within(panel()).findByText(/Идёт запись/)).toBeInTheDocument();
    expect(mic()).toHaveAttribute('aria-pressed', 'true');
    await sleep(450);
    await env.user.click(mic());
    await waitFor(() => expect(box()).toHaveValue('Купить хлеб и молоко на завтра'));
    // Never sent or applied: no chat request, no proposal, the user still has to press Send.
    expect(env.web.calls.filter((call) => call.url.endsWith('/responses'))).toHaveLength(0);
    expect(panel().querySelector('.ai-msg--user')).toBeNull();
    expect(within(panel()).getByRole('button', { name: 'Отправить' })).toBeEnabled();
    expect(box()).toHaveFocus();
    expect(stoppedTracks).toBe(1); // the microphone is released
    // The text stays editable.
    await env.user.type(box(), '!');
    expect(box()).toHaveValue('Купить хлеб и молоко на завтра!');
    expect(transcriptionCalls()).toHaveLength(1);
  });

  it('inserts at the cursor position inside existing text', async () => {
    await start([json({ text: 'в пятницу' })]);
    await env.user.type(box(), 'Встреча с врачом');
    box().setSelectionRange(7, 7); // after "Встреча"
    await record();
    await waitFor(() => expect(box()).toHaveValue('Встреча в пятницу с врачом'));
  });

  it('English dictation is inserted the same way', async () => {
    await start([json({ text: 'Move my exam to Friday at 4:30 pm' })]);
    await record();
    await waitFor(() => expect(box()).toHaveValue('Move my exam to Friday at 4:30 pm'));
  });

  it('microphone access denied: explains how to allow it; nothing is recorded or sent', async () => {
    await start();
    micAccess.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await env.user.click(mic());
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('Нет доступа к микрофону');
    expect(recorders).toHaveLength(0);
    expect(transcriptionCalls()).toHaveLength(0);
  });

  it('an empty or too short recording is not sent', async () => {
    await start();
    await record(50);
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('Запись пустая или слишком короткая');
    expect(transcriptionCalls()).toHaveLength(0);
  });

  it.each([
    ['a rejected key', json({ error: {} }, 401), 'OpenAI не принял ключ'],
    ['a network failure', new TypeError('fetch failed'), 'Нет связи с OpenAI'],
    ['no recognized speech', json({ text: '' }), 'Речь не распознана'],
  ])('%s: a clear message, and the message box keeps its text', async (_, reply, text) => {
    await start([reply]);
    await env.user.type(box(), 'Черновик');
    await record();
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(text);
    expect(box()).toHaveValue('Черновик');
  });

  it('without an OpenAI key (assistant on another service) it says what is needed and does not open the microphone', async () => {
    await start([], { provider: 'anthropic' });
    await env.user.click(mic());
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('Для голосового ввода нужен ключ OpenAI');
    expect(micAccess).not.toHaveBeenCalled();
  });

  it('a key for voice input can be saved in AI settings without changing the assistant service', async () => {
    await start([], { provider: 'anthropic' });
    env.web.push(json({ id: 'gpt-4o-mini-transcribe', object: 'model', created: 1, owned_by: 'system' }));
    await env.user.click(within(panel()).getByRole('button', { name: 'Настройки ИИ' }));
    const dialog = screen.getByRole('dialog', { name: 'ИИ-помощник' });
    await env.user.type(await within(dialog).findByLabelText('Ключ OpenAI для голосового ввода'), OPENAI_KEY);
    await env.user.click(within(dialog).getByRole('button', { name: 'Сохранить ключ' }));
    await within(dialog).findByText('Ключ проверен и сохранён в зашифрованном виде.');
    expect(env.web.calls.at(-1).url).toBe('https://api.openai.com/v1/models/gpt-4o-mini-transcribe');
    expect((await window.taskflow.ai.getSettings()).state).toMatchObject({ advanced: { provider: 'anthropic' }, speech: { available: true } });
    expect(document.body.innerHTML).not.toContain(OPENAI_KEY);
  });
});

describe('insertAtSelection', () => {
  it.each([
    ['empty box', '', 'Привет', 0, 0, 'Привет'],
    ['after text, adds a space', 'Купить', 'хлеб', 6, 6, 'Купить хлеб'],
    ['before punctuation, no extra space', 'Купить.', 'хлеб', 6, 6, 'Купить хлеб.'],
    ['replaces a selection', 'Купить X завтра', 'хлеб', 7, 8, 'Купить хлеб завтра'],
  ])('%s', (_, value, insert, start, end, expected) => {
    expect(insertAtSelection(value, insert, start, end, 2000).value).toBe(expected);
  });

  it('never exceeds the message limit and says when text was cut', () => {
    const result = insertAtSelection('x'.repeat(1995), 'длинный текст', 1995, 1995, 2000);
    expect(result.value).toHaveLength(2000);
    expect(result.truncated).toBe(true);
  });
});
