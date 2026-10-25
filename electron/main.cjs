// Electron main process: creates the Taskflow window and enforces security defaults.
const { app, BrowserWindow, Menu, Notification, ipcMain, powerMonitor, safeStorage, shell } = require('electron');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createStorage } = require('./storage.cjs');
const { createAiSettings } = require('./ai/aiSettings.cjs');
const { registerAiHandlers } = require('./ai/ipc.cjs');
const { createChatService } = require('./ai/chatService.cjs');
const { createConnection } = require('./ai/connection.cjs');
const { createSpeechService } = require('./ai/speech.cjs');
const { createReminderScheduler } = require('./reminders.cjs');

// Windows shows notifications under this id (the same as the installer's appId).
const APP_USER_MODEL_ID = 'app.taskflow.desktop';

// Close handshake: give the renderer this long to finish pending saves.
const CLOSE_FLUSH_TIMEOUT_MS = 3000;

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL) && !app.isPackaged;

// Only a local Vite dev server may be loaded in development.
function isAllowedDevUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

// The production page. Only this exact file counts as the app: any other local file (for
// example one dropped onto the window) must not be shown or reach the storage API.
const APP_INDEX = path.join(__dirname, '..', 'dist', 'index.html');
const comparablePath = (file) => {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

function isAppUrl(url) {
  if (isDev) return url.startsWith(DEV_SERVER_URL);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    parsed.hash = '';
    parsed.search = '';
    return comparablePath(fileURLToPath(parsed.href)) === comparablePath(APP_INDEX);
  } catch {
    return false;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Taskflow',
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Never open new Electron windows; https links go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep the window on the application's own content.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  // Before closing, ask the renderer to flush pending saves (with a timeout).
  let closeAllowed = false;
  let renderGone = false;
  win.webContents.on('render-process-gone', () => {
    renderGone = true;
  });
  win.on('close', (event) => {
    if (closeAllowed || renderGone || win.webContents.isLoading()) return;
    event.preventDefault();
    const finish = () => {
      if (closeAllowed) return;
      closeAllowed = true;
      clearTimeout(timer);
      ipcMain.removeListener('app:ready-to-close', onReady);
      if (!win.isDestroyed()) win.close();
    };
    const onReady = (readyEvent) => {
      if (readyEvent.sender === win.webContents) finish();
    };
    const timer = setTimeout(finish, CLOSE_FLUSH_TIMEOUT_MS);
    ipcMain.on('app:ready-to-close', onReady);
    win.webContents.send('app:before-close');
  });

  if (isDev && isAllowedDevUrl(DEV_SERVER_URL)) {
    win.loadURL(DEV_SERVER_URL);
  } else {
    win.loadFile(APP_INDEX);
  }

  return win;
}

// Only the app's own page may call any IPC handler.
const fromApp = (event) => isAppUrl(event.senderFrame?.url ?? '');

// Persistence IPC. Inputs are validated in storage.cjs.
// `onChange` runs after every load or save (the reminder schedule follows the saved data).
function registerStorageHandlers(storage, onChange = () => {}) {
  const guard = (handler) => (event, ...args) => {
    if (!fromApp(event)) return { ok: false, code: 'FORBIDDEN' };
    const result = handler(...args);
    onChange();
    return result;
  };
  ipcMain.handle('storage:load', guard(() => storage.load()));
  ipcMain.handle('storage:save-board', guard((board) => storage.saveBoard(board)));
  ipcMain.handle('storage:save-settings', guard((settings) => storage.saveSettings(settings)));
}

/** Desktop reminders from the saved tasks (see reminders.cjs). Clicking one shows the window. */
function startReminders(storage) {
  const scheduler = createReminderScheduler({
    dir: app.getPath('userData'),
    // Only data the window has already loaded: the scheduler never performs the first load.
    getData: () => storage.peek(),
    notify: ({ title, body }) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title, body });
      notification.on('click', () => {
        const [win] = BrowserWindow.getAllWindows();
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
      });
      notification.show();
    },
  });
  // Timers do not run while Windows sleeps: check at once after resume / unlock.
  powerMonitor.on('resume', scheduler.refresh);
  powerMonitor.on('unlock-screen', scheduler.refresh);
  app.on('before-quit', scheduler.stop);
  scheduler.start();
  return scheduler;
}

// Deny every permission request (camera, notifications, location, etc.) - except the microphone
// for voice input, and only for the app's own page asking for audio alone (never video).
function lockDownPermissions() {
  const { session } = require('electron');
  const audioOnly = (permission, details) =>
    permission === 'media' && Array.isArray(details?.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((type) => type === 'audio');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(audioOnly(permission, details) && isAppUrl(details?.requestingUrl ?? webContents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (permission !== 'media' || details?.mediaType !== 'audio') return false;
    return isAppUrl(details?.requestingUrl ?? requestingOrigin ?? '');
  });
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    if (!isDev) Menu.setApplicationMenu(null);
    lockDownPermissions();
    // Per-user data folder, e.g. %APPDATA%\Taskflow on Windows.
    app.setAppUserModelId(APP_USER_MODEL_ID);
    const storage = createStorage(app.getPath('userData'));
    let reminders = null;
    registerStorageHandlers(storage, () => reminders?.refresh());
    reminders = startReminders(storage);
    // AI settings live in their own file; nothing is read or written until the renderer asks.
    // The assistant sees category names/ids and only the few relevant tasks (id, title, status,
    // due date), all read from the saved data.
    // Nothing is sent to a provider until the user presses Connect or writes to the assistant.
    const aiSettings = createAiSettings({ dir: app.getPath('userData'), safeStorage });
    const connection = createConnection({ settings: aiSettings });
    const chat = createChatService({
      settings: aiSettings,
      onResult: connection.noteRequest,
      getCategories: () => storage.peek()?.categories ?? [],
      getTasks: () => storage.peek()?.tasks ?? [],
      getAppSettings: () => storage.peek()?.settings ?? {},
    });
    registerAiHandlers({ ipcMain, settings: aiSettings, connection, chat, speech: createSpeechService({ settings: aiSettings }), isTrustedSender: fromApp });
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
