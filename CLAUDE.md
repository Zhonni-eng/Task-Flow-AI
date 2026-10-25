# Task Flow — instructions for Claude Code

Electron 45 + React 19 + Vite desktop Kanban app for Windows (x64), Russian (default) and English.
User docs and feature details: [README.md](README.md). Test groups and focused runs: [TESTING.md](TESTING.md).
Read those only for the section you need.

## Layout

| Path | What |
|---|---|
| `electron/main.cjs` | Main process: window, security, IPC registration, reminders |
| `electron/preload.cjs` | The only bridge to the page (`window.taskflow`) |
| `electron/storage.cjs` | Versioned JSON storage (schema v4), validation, migrations, atomic writes |
| `electron/ai/` | AI settings and encrypted keys, connection checks, chat, prompt, speech; `providers/` (Anthropic, OpenAI, Gemini, OpenAI-compatible) |
| `electron/shared/schedule.mjs` | Date/time/reminder/repeat rules shared by main and renderer |
| `src/` | Renderer: `App.jsx`, `components/`, `state/` (reducers, views, persistence), `data/` (task/category models), `ai/` (plan validation `actionPlan.js`, apply/undo `applyPlan.js`, `useAssistant.js`, voice), `i18n/translations.js` |
| `tests/` | Vitest: `unit/`, `storage/`, `components/` (whole app, jsdom); `electron/smoke.mjs` (real window) |
| `build/` | Packaging resources: `icon.png`, `portable/` (launcher `Task Flow.bat` + README for the ZIP) |
| `scripts/` | `dev.mjs`, `package-portable.mjs` (+ `zip-folder.mjs`), `start-packaged.mjs`, `icon/` |

## Commands

```bash
npm install                 # dependencies (Node 22+)
npm run dev                 # Vite + Electron (development)
npm test                    # all Vitest tests (~900, capped at 4 workers)
npx vitest run <file>       # one test file - prefer this while iterating
npm run build               # production build of the renderer into dist/
npm run test:electron       # smoke test in a real Electron window (needs dist/)
npm run package:portable    # portable ZIP -> release/<version>-portable/ (refuses if it exists)
node tests/electron/smoke.mjs --exe "release/<version>-portable/Task Flow/app/Taskflow.exe"
npm run package:win         # NSIS installer; default output release/ (overwrites release/win-unpacked)
```

`Run-Taskflow.bat` starts the development version for manual testing with the separate data folder
`%LOCALAPPDATA%\Taskflow Dev`. The portable `Task Flow.bat` starts the packaged app only.

## Rules

- Make minimal, targeted changes; preserve existing behavior, confirmation and Undo. No unrelated
  refactoring. Add or update a regression test with each fix; run the affected test files, then
  `npm test` and `npm run build` before finishing.
- Inspect only files relevant to the task. Do not scan or read `node_modules/`, `release/`, `dist/`,
  `.vitest/` or other generated output. `translations.js` and `TESTING.md` are large: search them.
- Releases: never overwrite, rebuild over or delete anything in `release/` (installers, the portable
  ZIP, checksums). Check a packaging command's output path first; bump the version for new builds.
- User data: never open or modify the real `%APPDATA%\Taskflow` folder. Tests and manual runs use
  temporary or `--user-data-dir` folders.
- Never read, print, log or copy API keys; never use a stored key for live requests unless asked.

## Security invariants (keep them)

- Window: `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity`; navigation and new
  windows outside the app are blocked; Electron fuses in `package.json` (`build.electronFuses`).
- IPC: every handler checks the sender (`fromApp` / `isTrustedSender`) and validates payloads; the
  preload exposes only the narrow `window.taskflow` API - never Node or `ipcRenderer` itself.
- Storage: data is validated on load and save; writes are atomic with a `.bak` copy; unreadable data
  is preserved, never discarded.
- API keys: stored only encrypted with Electron `safeStorage` (DPAPI on Windows), no plaintext
  fallback; they stay in the main process and never reach the renderer, results, errors or logs.
- AI proposals are untrusted: validated against real data (`actionPlan.js`), shown for review,
  applied only after confirmation, undoable.

## Platforms

Windows packaging (installer, portable ZIP) is the only shipped target. macOS (Electron on a Mac:
dmg target, `.icns`, signing and notarization, `NSMicrophoneUsageDescription`, no `.bat` launchers)
and mobile (React Native + Expo, a separate app that would share only the platform-free logic in
`src/data/`, `src/ai/actionPlan.js`, `electron/shared/`) are separate future workflows - do not mix
them into Windows packaging changes.
