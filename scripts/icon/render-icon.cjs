// Renders build/icon.png (256×256) from the app's existing logo mark (see LogoIcon in
// src/components/Icons.jsx and .sidebar__logo in src/styles/layout.css) using an
// offscreen Electron window. Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 256;
const outFile = path.resolve(__dirname, '..', '..', 'build', 'icon.png');

const html = `<!doctype html><html><head><style>
  html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; overflow: hidden; }
  .tile { box-sizing: border-box; width: ${SIZE}px; height: ${SIZE}px; border-radius: 56px; display: grid; place-items: center;
          background: linear-gradient(135deg, #2ee6b6 0%, #4fd6e6 100%); }
  svg { width: 150px; height: 150px; color: #06261e; }
</style></head><body><div class="tile">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="5" height="16" rx="1.5" />
    <rect x="10" y="4" width="5" height="10" rx="1.5" />
    <rect x="17" y="4" width="4" height="6" rx="1.5" />
  </svg>
</div></body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = (await win.webContents.capturePage()).resize({ width: SIZE, height: SIZE, quality: 'best' });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, image.toPNG());
  console.log(`Wrote ${outFile} (${image.getSize().width}x${image.getSize().height})`);
  app.quit();
});
