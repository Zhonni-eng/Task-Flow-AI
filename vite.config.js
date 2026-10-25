import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Strict Content Security Policy injected into the production build only
// (the dev server needs inline scripts for React Fast Refresh).
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'";

function productionCsp() {
  return {
    name: 'taskflow-production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

// The version shown in the app comes from package.json (single source for app and installer).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  // Relative asset paths so the build loads correctly from file:// inside Electron.
  base: './',
  plugins: [react(), productionCsp()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    port: 5173,
    strictPort: false,
    open: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
