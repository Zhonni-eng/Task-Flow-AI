// Starts the unpacked production build created by `npm run package:win`
// (release/win-unpacked/Taskflow.exe). Extra arguments are passed through.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'release', 'win-unpacked', 'Taskflow.exe');

if (!fs.existsSync(exe)) {
  console.error(`Packaged app not found: ${exe}\nRun "npm run package:win" first.`);
  process.exit(1);
}

const child = spawn(exe, process.argv.slice(2), { stdio: 'inherit', detached: false });
child.on('exit', (code) => process.exit(code ?? 0));
