// Preload script (sandboxed). Exposes a minimal API to the renderer: a few named
// persistence and AI-settings operations over IPC. No Node.js, filesystem, or shell access is exposed.
const { contextBridge, ipcRenderer } = require('electron');

let beforeCloseRegistered = false;

const storage = Object.freeze({
  load: () => ipcRenderer.invoke('storage:load'),
  /** Saves { tasks, categories } together. */
  saveBoard: (board) => ipcRenderer.invoke('storage:save-board', board),
  saveSettings: (settings) => ipcRenderer.invoke('storage:save-settings', settings),
  /** Registers one async handler that runs before the window closes (to flush saves). */
  onBeforeClose: (handler) => {
    if (beforeCloseRegistered || typeof handler !== 'function') return;
    beforeCloseRegistered = true;
    ipcRenderer.on('app:before-close', async () => {
      try {
        await handler();
      } finally {
        ipcRenderer.send('app:ready-to-close');
      }
    });
  },
});

// AI settings. The API key can be sent to be tested and stored, but is never returned to the page.
const ai = Object.freeze({
  getSettings: () => ipcRenderer.invoke('ai:get-settings'),
  /** { enabled } */
  saveSettings: (changes) => ipcRenderer.invoke('ai:save-settings', changes),
  /** { key, provider?, baseUrl?, model? } to test and store a new key; no argument to test the stored key again. */
  connect: (request) => ipcRenderer.invoke('ai:connect', request),
  disconnect: () => ipcRenderer.invoke('ai:disconnect'),
  /** { message, language, recentTaskIds? } -> the assistant's proposal (validated and confirmed in the app). */
  chat: (request) => ipcRenderer.invoke('ai:chat', request),
  resetChat: () => ipcRenderer.invoke('ai:reset-chat'),
  /** { audio: Uint8Array, mimeType } -> { ok, text } (the text is only put into the message box). */
  transcribe: (request) => ipcRenderer.invoke('ai:transcribe', request),
  /** { key } - an OpenAI key for voice input only (checked, then stored encrypted). */
  connectSpeech: (request) => ipcRenderer.invoke('ai:connect-speech', request),
});

contextBridge.exposeInMainWorld(
  'taskflow',
  Object.freeze({
    platform: process.platform,
    isDesktop: true,
    storage,
    ai,
  }),
);
