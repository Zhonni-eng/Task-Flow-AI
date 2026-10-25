// Isolated temporary folders for storage tests. Never points at the real user-data folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createTempDir(prefix = 'taskflow-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    file: (name) => path.join(dir, name),
    list: () => fs.readdirSync(dir).sort(),
    readJson: (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')),
    writeJson: (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2)),
    writeText: (name, text) => fs.writeFileSync(path.join(dir, name), text),
    remove: () => {
      // Only ever removes the folder this helper created inside the OS temp directory.
      if (dir.startsWith(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
