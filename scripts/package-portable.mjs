// Builds the portable Windows ZIP (no Node.js, npm or installer needed on the target PC):
//   release/<version>-portable/
//     Task Flow/Task Flow.bat      launcher (build/portable)
//     Task Flow/README.txt         RU/EN instructions (build/portable)
//     Task Flow/app/               the packaged app (electron-builder "dir" target)
//     TaskFlow-<version>-portable-win-x64.zip   the "Task Flow" folder, zipped
//     SHA256SUMS.txt
// Never overwrites: stops if the output folder already exists. Task data and AI settings stay in
// the app's user-data folder (%APPDATA%\Taskflow), never in the portable folder.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipFolder } from './zip-folder.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'release', `${version}-portable`);
const buildDir = path.join(outDir, 'build');
const appFolder = path.join(outDir, 'Task Flow');
const zipName = `TaskFlow-${version}-portable-win-x64.zip`;
const zipPath = path.join(outDir, zipName);

if (process.platform !== 'win32') {
  console.error('The portable Windows build must be made on Windows.');
  process.exit(1);
}
if (fs.existsSync(outDir)) {
  console.error(`Output folder already exists, nothing was changed: ${outDir}\nMove it away or bump the version first.`);
  process.exit(1);
}

const run = (command) => execSync(command, { cwd: root, stdio: 'inherit' });
run('npm run build');
run(`npx electron-builder --win dir --x64 -c.directories.output="${buildDir}"`);

const unpacked = path.join(buildDir, 'win-unpacked');
if (!fs.existsSync(path.join(unpacked, 'Taskflow.exe'))) {
  console.error(`Packaged app not found in ${unpacked}`);
  process.exit(1);
}
fs.mkdirSync(appFolder);
fs.renameSync(unpacked, path.join(appFolder, 'app'));
for (const file of ['Task Flow.bat', 'README.txt']) fs.copyFileSync(path.join(root, 'build', 'portable', file), path.join(appFolder, file));
// Builder logs and icon cache of this build only (they hold local paths); the app is already moved out.
fs.rmSync(buildDir, { recursive: true, force: true });

// The ZIP holds the "Task Flow" folder itself.
zipFolder(appFolder, zipPath);

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${sha256(zipPath)}  ${zipName}\n`);

const folderSize = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const full = path.join(dir, entry.name);
    return sum + (entry.isDirectory() ? folderSize(full) : fs.statSync(full).size);
  }, 0);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(`\nPortable build ready: ${outDir}`);
console.log(`  ZIP:       ${zipName} (${mb(fs.statSync(zipPath).size)})`);
console.log(`  Extracted: ${mb(folderSize(appFolder))}`);
