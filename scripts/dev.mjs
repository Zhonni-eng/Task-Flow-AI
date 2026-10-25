// Development runner: starts the Vite dev server, then launches Electron pointed at it.
// Extra CLI arguments are forwarded to Electron.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

const server = await createServer({ server: { open: false } });
await server.listen();

const url = server.resolvedUrls?.local?.[0];
if (!url) {
  console.error('Could not resolve the Vite dev server URL.');
  await server.close();
  process.exit(1);
}

server.printUrls();
console.log('\nLaunching Taskflow in Electron...\n');

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

const shutdown = async (code) => {
  await server.close();
  process.exit(code ?? 0);
};

child.on('close', shutdown);
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
