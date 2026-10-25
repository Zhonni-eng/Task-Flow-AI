// Global test setup. DOM-only parts are skipped for tests running in the Node environment.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// No test may reach a real AI provider: any request to one fails immediately, even through the
// real SDK. Tests inject fake clients or a fake `fetch` instead.
const BLOCKED_HOSTS = ['anthropic.com', 'claude.ai', 'openai.com', 'googleapis.com', 'generativelanguage'];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (BLOCKED_HOSTS.some((host) => url.includes(host))) {
    return Promise.reject(new Error(`Blocked in tests: no real AI requests (${new URL(url).host})`));
  }
  return realFetch(input, init);
};

if (typeof window !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  const { installDialogPolyfill } = await import('./dialogPolyfill.js');

  installDialogPolyfill();

  // jsdom has no layout engine: provide no-op versions of layout APIs used by the app.
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    delete window.taskflow;
  });
}
