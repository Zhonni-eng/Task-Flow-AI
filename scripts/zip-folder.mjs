// Zips a folder (the folder itself becomes the ZIP's top-level entry) with Windows' own zip
// support - no extra dependency. Entry names use forward slashes as the ZIP format requires:
// ZipFile.CreateFromDirectory in Windows PowerShell 5.1 (.NET Framework) writes backslashes, which
// other unzip tools turn into flat file names such as "Task Flow\app\Taskflow.exe".
// Refuses to overwrite an existing ZIP.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const SCRIPT = [
  'Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem',
  '$source = (Resolve-Path -LiteralPath $env:TF_SOURCE).Path.TrimEnd([char]92)',
  '$base = Split-Path -Leaf $source',
  "$zip = [System.IO.Compression.ZipFile]::Open($env:TF_ZIP, 'Create')",
  'try {',
  '  Get-ChildItem -LiteralPath $source -Recurse -File -Force | ForEach-Object {',
  "    $name = $base + '/' + $_.FullName.Substring($source.Length + 1).Replace([char]92, [char]47)",
  "    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name, 'Optimal')",
  '  }',
  '} finally { $zip.Dispose() }',
].join('\n');

export function zipFolder(sourceDir, zipPath) {
  if (fs.existsSync(zipPath)) throw new Error(`ZIP already exists, not overwritten: ${zipPath}`);
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
    stdio: 'inherit',
    env: { ...process.env, TF_SOURCE: sourceDir, TF_ZIP: zipPath },
  });
}
