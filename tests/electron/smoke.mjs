// Electron smoke test: launches the BUILT app (dist/) in a real Electron window with an
// isolated, temporary user-data folder, drives it over the Chrome DevTools Protocol and
// checks what Vitest/jsdom cannot: real window loading, Electron security settings, the
// preload bridge, IPC persistence, the close-time save flush and keyboard drag-and-drop.
//
// Usage: npm run build && npm run test:electron        (dev Electron + dist/)
//        npm run package:win && npm run test:packaged   (release/win-unpacked/Taskflow.exe)
//        node tests/electron/smoke.mjs --exe <path\to\Taskflow.exe>   (any packaged build, e.g. portable)
// It never touches the real %APPDATA%\Taskflow folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exeArg = process.argv.indexOf('--exe');
const customExe = exeArg >= 0 ? path.resolve(process.argv[exeArg + 1] ?? '') : null;
const packaged = process.argv.includes('--packaged') || Boolean(customExe);
const executable = packaged
  ? customExe ?? path.join(root, 'release', 'win-unpacked', 'Taskflow.exe')
  : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-smoke-'));
const PORT = 9520 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let running = null; // the Electron process currently under test (killed on abort)

const results = [];
const check = (name, ok, detail) => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
};

async function waitFor(fn, { timeout = 15000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await Promise.resolve().then(fn).catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting for condition');
    await sleep(interval);
  }
}

async function launch() {
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`];
  const app = spawn(executable, packaged ? args : ['.', ...args], { cwd: root, stdio: 'ignore' });
  running = app;
  const exited = new Promise((resolve) => app.on('exit', resolve));
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return list.find((item) => item.type === 'page');
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, returnByValue: true, awaitPromise: true });
    if (reply.error || reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails));
    return reply.result.result.value;
  };
  const key = async (name, code, keyCode, text) => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: keyCode, ...(type === 'keyDown' && text ? { text } : {}) });
    }
    await sleep(200);
  };
  await waitFor(() => evaluate(`return !!document.querySelector('.task-card, .view-status--empty')`));
  return {
    evaluate,
    key,
    send,
    errors,
    async close() {
      evaluate('window.close()').catch(() => {});
      await Promise.race([exited, sleep(8000)]);
      if (app.exitCode === null) app.kill();
    },
  };
}

const dataFile = () => JSON.parse(fs.readFileSync(path.join(userData, 'taskflow-data.json'), 'utf8'));
const titlesIn = (status) => `return [...document.querySelectorAll('.column--${status} .task-card__open')].map(e => e.textContent)`;

try {
  if (!fs.existsSync(executable)) throw new Error(`${executable} is missing: run "npm run package:win" first`);
  if (!packaged && !fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('dist/ is missing: run "npm run build" first');
  console.log(`Testing ${packaged ? 'packaged app' : 'development Electron with dist/'}: ${executable}`);

  let app = await launch();
  const runtime = await app.evaluate(`return { url: location.protocol, require: typeof require, process: typeof process, api: Object.keys(window.taskflow ?? {}).sort(), storage: Object.keys(window.taskflow?.storage ?? {}).sort(), ai: Object.keys(window.taskflow?.ai ?? {}).sort() }`);
  check('Production build loads from file:// in an Electron window', runtime.url === 'file:');
  check('Node.js is not exposed to the page (contextIsolation, no nodeIntegration)', runtime.require === 'undefined' && runtime.process === 'undefined', runtime);
  check('Preload exposes only the restricted storage and AI-settings APIs', JSON.stringify(runtime.api) === JSON.stringify(['ai', 'isDesktop', 'platform', 'storage']) && JSON.stringify(runtime.storage) === JSON.stringify(['load', 'onBeforeClose', 'saveBoard', 'saveSettings']) && JSON.stringify(runtime.ai) === JSON.stringify(['chat', 'connect', 'connectSpeech', 'disconnect', 'getSettings', 'resetChat', 'saveSettings', 'transcribe']), runtime);

  // AI connection: keys are only stored after a successful connection test, which needs the network,
  // so this smoke test only uses keys that are refused locally - it never makes a request. (The
  // encrypted round trip is covered by unit tests and the manual check in TESTING.md.)
  const aiResult = await app.evaluate(`const ai = window.taskflow.ai; return {
    defaults: (await ai.getSettings()).state,
    unidentified: await ai.connect({ key: 'smoke-test-unrecognized-0123456789abcdef' }),
    badAddress: await ai.connect({ key: 'smoke-token', provider: 'openai-compatible', baseUrl: 'http://example.test/v1', model: 'm' }),
    malformed: await ai.connect({ key: 'sk-ant-short' }),
    recheck: await ai.connect(),
    enable: await ai.saveSettings({ enabled: true }),
    choice: await ai.saveSettings({ model: 'claude-haiku-5-5' }),
  }`);
  const aiDefaults = aiResult.defaults;
  check('AI is off and not connected by default; the page sees no provider or model', aiDefaults.enabled === false && aiDefaults.connection === 'none' && aiDefaults.secureStorage === 'available' && aiDefaults.advanced?.provider === null && !/claude|gpt-|gemini-/i.test(JSON.stringify(aiDefaults)), aiDefaults);
  check('Unrecognized or malformed keys and non-HTTPS addresses are refused locally, AI cannot be enabled unconnected, nothing is stored', aiResult.unidentified.code === 'UNIDENTIFIED_KEY' && aiResult.badAddress.code === 'INVALID_BASE_URL' && aiResult.malformed.code === 'INVALID_KEY' && aiResult.recheck.code === 'NO_KEY' && aiResult.enable.code === 'NOT_CONNECTED' && aiResult.choice.code === 'INVALID_INPUT' && !fs.existsSync(path.join(userData, 'taskflow-ai.json')), aiResult);
  const chatWhileOff = await app.evaluate(`return await window.taskflow.ai.chat({ message: 'Купить молоко', language: 'ru' })`);
  const forged = await app.evaluate(`return await window.taskflow.ai.chat({ message: 'x', plan: { actions: [{ type: 'create', title: 'Forged' }] } })`);
  check('Assistant refuses while AI is off, and rejects forged payloads (no request is made)', chatWhileOff.ok === false && chatWhileOff.code === 'AI_DISABLED' && forged.ok === false && forged.code === 'INVALID_INPUT', { chatWhileOff, forged });
  check('First launch shows 8 sample tasks in Russian', (await app.evaluate(`return document.querySelectorAll('.task-card').length`)) === 8 && (await app.evaluate(`return document.documentElement.lang`)) === 'ru');
  await waitFor(() => fs.existsSync(path.join(userData, 'taskflow-data.json')));
  check('Data file is created in the isolated user-data folder (schema v4)', dataFile().schemaVersion === 4 && dataFile().tasks.length === 8);

  // Create a task, then close immediately: the close handshake must flush the save.
  await app.evaluate(`document.querySelector('.header .btn--primary').click()`);
  await sleep(300);
  await app.send('Input.insertText', { text: 'Smoke test task' });
  await app.evaluate(`document.querySelector('dialog[open] button[type=submit]').click(); window.close();`).catch(() => {});
  await app.close();

  app = await launch();
  check('Task created right before closing survives a restart', (await app.evaluate(titlesIn('todo')))[0] === 'Smoke test task');

  // Keyboard drag-and-drop with the grip handle (needs real layout, so Electron only).
  const before = await app.evaluate(titlesIn('todo'));
  await app.evaluate(`[...document.querySelectorAll('.task-card')].find(c => c.querySelector('.task-card__open').textContent === 'Smoke test task').querySelector('.task-card__handle').focus()`);
  await app.key(' ', 'Space', 32, ' ');
  await app.key('ArrowRight', 'ArrowRight', 39);
  await app.key(' ', 'Space', 32, ' ');
  await sleep(400);
  const inProgress = await app.evaluate(titlesIn('inProgress'));
  check('Keyboard drag moves a task to the next column', inProgress.includes('Smoke test task') && !(await app.evaluate(titlesIn('todo'))).includes('Smoke test task'), { before, inProgress });
  await waitFor(() => dataFile().tasks.find((task) => task.title === 'Smoke test task')?.status === 'inProgress');
  check('Moved status is persisted', dataFile().tasks.find((task) => task.title === 'Smoke test task').status === 'inProgress');

  // Remembered language.
  await app.evaluate(`[...document.querySelectorAll('.lang-switcher__option')].find(b => b.textContent === 'EN').click()`);
  await waitFor(() => dataFile().settings.language === 'en');
  check('No uncaught page errors', app.errors.length === 0, app.errors);
  await app.close();

  app = await launch();
  check('Language is remembered after restart', (await app.evaluate(`return document.documentElement.lang`)) === 'en');
  const aiAfterRestart = await app.evaluate(`return (await window.taskflow.ai.getSettings()).state`);
  check('After a restart AI is still off and not connected (nothing was checked automatically)', aiAfterRestart.connection === 'none' && aiAfterRestart.enabled === false && dataFile().schemaVersion === 4, aiAfterRestart);

  // Only the app's own page may be shown: navigating to another local file is blocked, so a
  // foreign page can never reach the storage API.
  const foreign = path.join(userData, 'foreign.html');
  fs.writeFileSync(foreign, '<!doctype html><title>Foreign</title>');
  const appUrl = await app.evaluate(`return location.href`);
  await app.evaluate(`setTimeout(() => { location.href = ${JSON.stringify(pathToFileURL(foreign).href)}; }, 0)`);
  await sleep(1200);
  const urlAfter = await app.evaluate(`return location.href`).catch(() => 'navigated away');
  check('Navigation to another local file is blocked', urlAfter === appUrl && dataFile().tasks.length === 9, { appUrl, urlAfter });
  await app.close();
} catch (error) {
  check(`Smoke test aborted: ${error.message}`, false);
} finally {
  if (running && running.exitCode === null) running.kill();
  await sleep(500);
  // Electron may hold files briefly after exit on Windows; retry the cleanup.
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} Electron smoke checks passed`);
process.exit(passed === results.length ? 0 : 1);
