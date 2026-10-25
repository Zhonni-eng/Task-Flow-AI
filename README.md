# Taskflow

A desktop Kanban task manager for Windows built with Electron, React and Vite. Works offline,
stores data locally and supports Russian (default) and English.

Features: tasks with descriptions, priorities, due dates and optional exact times, reminders,
repeating tasks, estimates, labels and subtasks; desktop reminders; drag-and-drop between and within
columns; categories; Board and List views; bulk actions; search, filters (including overdue / due
today / upcoming), sorting and statistics; and an optional AI assistant (Anthropic Claude, OpenAI
GPT, Google Gemini or an OpenAI-compatible API) that manages tasks from plain sentences - create,
edit, delete, reschedule, categorize, split into subtasks, bulk changes, day plans, questions about
your tasks - always after you review and confirm.

## Requirements

- Windows 10 or 11 (x64) to run the app. Users of the installer need nothing else — the
  Electron runtime is bundled, no Node.js installation is required.
- For development: Node.js 22 or newer (developed with Node 24) and npm.

## Development

```bash
npm install          # install dependencies
npm run dev          # start Vite and open the app in an Electron window
npm run build        # production build of the interface into dist/
npm run build:start  # build, then run that production build in Electron
```

For manual testing on Windows, double-click `Run-Taskflow.bat` **in this project folder**: it checks
Node.js (22+), the project files and the dependencies (installing them when missing or older than
`package-lock.json`), shows the folder and version it starts, and runs `npm run dev` with a separate
test data folder (`%LOCALAPPDATA%\Taskflow Dev`), so your real data is never opened. On the first
run it copies the Taskflow files of the earlier test folder (`%LOCALAPPDATA%\Taskflow 0.2.0 Preview`)
into the new one, so test tasks and a connected AI key carry over; the old folder is left as it is.

> A copy of `Run-Taskflow.bat` inside another project folder - for example the `Task Flow 0.2.0`
> snapshot next to this project - starts **that** folder's code (an older version). The banner and
> the window title show which folder and version are running.

## Tests

```bash
npm test                                   # unit, storage and component tests (Vitest)
npm run test:watch                         # watch mode
npm run build && npm run test:electron     # smoke test in a real Electron window
npm run package:win && npm run test:packaged   # same smoke test against the packaged app
```

See [TESTING.md](TESTING.md) for focused runs, what each test group covers and which checks need a
real Electron window. Tests never use the real `%APPDATA%\Taskflow` folder.

## Packaging the Windows installer

```bash
npm run package:win      # build dist/ and create the installer
npm run release:win      # run all tests first, then package
npm run start:packaged   # run release/win-unpacked/Taskflow.exe (after package:win) without installing
npm run icon             # re-create build/icon.png from the app logo (optional)
```

Output (in `release/`):

| File | Purpose |
|---|---|
| `Taskflow-Setup-<version>.exe` | The installer to distribute (x64, NSIS). |
| `Taskflow-Setup-<version>.exe.blockmap` | Used only for future differential updates; not needed by users. |
| `win-unpacked/` | The unpacked application, useful for testing without installing. |

The version comes from `version` in `package.json` (currently 0.3.0); bump it before each release so
an installer can upgrade the previous version in place.

Packaging details (see the `build` section of `package.json`):

- App ID `app.taskflow.desktop`, product name **Taskflow**, icon `build/icon.png`.
- Only `electron/`, `dist/` and the production dependency `@anthropic-ai/sdk` (with its own small
  dependencies) are packaged inside `app.asar`; sources, tests and development dependencies are not
  shipped. React and dnd-kit are bundled into `dist/` by Vite. From dependencies, TypeScript sources
  and type definitions, source maps and the SDK's unused ES-module copies are excluded (the app loads
  the SDK's CommonJS build).
- Only the English and Russian Chromium language files are kept (`electronLanguages`), and the
  installer uses maximum compression.
- Sizes (0.3.0): installer ~99 MiB, installed app ~313 MiB (`Taskflow.exe`, the Electron/Chromium
  runtime, is ~239 MB of it and cannot be made smaller without changing frameworks). A development
  checkout is much larger: `node_modules/` (~540 MB) and every build in `release/` (each unpacked
  app ~310-390 MB) - old `release/` folders can be deleted when no longer needed.
- Electron security fuses are enabled: no "run as Node" mode, no `NODE_OPTIONS`, no Node inspector
  flags, ASAR integrity validation and loading the app only from `app.asar`.

## Portable ZIP (no installer)

```bash
npm run package:portable   # build dist/ and create release/<version>-portable/
node tests/electron/smoke.mjs --exe "release/<version>-portable/Task Flow/app/Taskflow.exe"
```

The output folder holds `TaskFlow-<version>-portable-win-x64.zip`, its `SHA256SUMS.txt` and the
unzipped `Task Flow/` folder: `Task Flow.bat` (the launcher), `README.txt` (RU/EN instructions,
from `build/portable/`) and `app/` (the same packaged app as the installer's). On the target PC:
extract the ZIP, double-click `Task Flow.bat` - no Node.js, npm or installation needed. The script
never overwrites an existing output folder; bump the version or move the old folder first.

- Size (0.3.0): ZIP ~140 MB, extracted ~313 MB.
- Data is stored in `%APPDATA%\Taskflow` like the installed app (shared with an installed copy on the
  same PC), never next to the program; API keys stay encrypted with Windows DPAPI and must be entered
  again on another PC.
- The app is not code-signed: SmartScreen may warn, and Smart App Control may block it.

## AI assistant (optional, since 0.3.0)

The sparkle button in the header opens the assistant panel. From plain sentences in Russian or
English it can:

- **create tasks** with a description, deadline and exact time, priority, category, subtasks,
  reminders, a repeat rule and an estimate - "Prepare for my economics exam. Review GDP, study
  inflation, and complete practice tests" becomes one task with a description and three subtasks
  (explanations are not turned into subtasks);
- **edit existing tasks**: rename, change the description, status, priority, category, deadline and
  time ("Move my exam to Friday at 16:30", "Remove the due time but keep the date"), reminders,
  repeat ("Remind me to pay rent on the first of every month") and estimate; **delete** tasks;
- **manage subtasks**: add, rename, complete, reopen, delete, and move one to another task;
- **bulk changes**: "Move all overdue tasks to tomorrow", "Mark all Study tasks as completed",
  "Delete completed tasks older than a month" - the app itself finds the matching tasks and lists
  every one (with the count) before anything changes;
- **answer questions** about your tasks ("What is overdue?", "What is left in Study?") from your
  actual data;
- **propose a day plan** within the available time set in *Settings*, using task estimates - a
  suggestion until you apply it; applying adds planned times to the tasks, deadlines do not change.

It never invents times, durations or availability: when a request could mean several tasks, a date
or time is unclear, or information is missing, it asks instead of guessing. Categories: an existing
category is reused (also in another case, word form or language - "учеба", "Study" = "Учёба"); a
new one is shown as new and created only when you confirm.

**Setting it up**

1. Get an API key from Anthropic (console.anthropic.com), OpenAI (platform.openai.com) or Google AI
   Studio (aistudio.google.com). Usage is billed by that service to the key's account.
2. Open the assistant (sparkle button) → *AI settings*.
3. Paste the key and press *Connect*. Taskflow checks the key first; only if that works is the key
   saved and the assistant switched on, and the status shows *Connected*. If not, it shows
   *Connection failed* with the reason (wrong or revoked key, no internet, rate limit, service
   unavailable…) and nothing is saved.

Usually there is nothing else to choose: the service is suggested by the key and confirmed by the
check, and Taskflow uses one fixed model for it. The default settings contain only the key field,
*Connect* / *Reconnect*, the status, *Enable the AI assistant* (available once a key has been
verified) and *Disconnect and remove key*. A collapsed *Advanced* section lets you choose the
service yourself (for keys that are not recognized) or set up an OpenAI-compatible API.

- *Reconnect* with a new key replaces the saved key only if the new key works; otherwise the
  previous key stays in use. *Reconnect* with an empty field checks the saved key again.
- After a restart the status is *Key saved* with the time of the last successful check, not
  *Connected*: a saved key is not assumed to work until a check or a message to the assistant
  succeeds.

**Supported services and how they are recognized**

| Service | Model used | Key check (no tokens, no tasks) | Requests |
|---|---|---|---|
| Anthropic Claude | `claude-opus-5-5` | retrieve model (official SDK) | Messages API, JSON schema output |
| OpenAI GPT | `gpt-6-astra` | `GET /v1/models/gpt-6-astra` | Responses API, strict JSON schema, `store: false` |
| Google Gemini | `gemini-3.8-flash` | `GET /v1beta/models/gemini-3.8-flash` | `generateContent` with a response schema |
| OpenAI-compatible API (advanced) | your model ID | `GET {base URL}/models` (the model must be listed) | `{base URL}/chat/completions` with `json_schema` |

Model IDs and request formats were checked against each service's official documentation on
2026-10-24 (OpenAI's own recommended starting model; Gemini's current stable Flash model).

- **Recognition is a suggestion, the check is the proof.** The key's shape suggests one service:
  `sk-ant-…` → Anthropic, other `sk-…` → OpenAI, `AIza…` → Google. The key counts as belonging
  to that service only if that service's check succeeds.
- **No guessing, no key spraying.** Key formats are not documented by every service and can change
  (new Google AI Studio keys have no documented format). A key whose shape suggests no service, or
  several, is not sent anywhere: the settings say so and ask you to choose the service under
  *Advanced*. A key is only ever sent to one service, never tried against several.
- **OpenAI-compatible APIs** (local servers, gateways): under *Advanced* choose *OpenAI-compatible
  API* and enter the base URL (HTTPS, or HTTP only for this computer, e.g.
  `http://localhost:11434/v1`) and the model ID from the service's documentation. The key is sent
  only to that address. These services implement OpenAI's Chat Completions format to different
  degrees; Taskflow validates every answer like any other.
- Keys are stored per service (each only ever used for its own service); *Disconnect and remove
  key* removes all of them and the OpenAI-compatible settings.

**How changes are made**

- The assistant only **proposes** changes. You review them (each change shows the task and "from →
  to"; deletions say what is deleted with the task) - likely duplicates, changes that change nothing
  and several changes to one task are unticked - and nothing changes until you confirm.
- Every proposal is validated against your current tasks (ids, dates, times, priorities, categories,
  parent/child links of subtasks, availability and overlaps of day plans) when it arrives and again
  right before it is applied; only tasks that were shown to the assistant in this conversation can
  be changed, and a bulk change is applied only if it still matches exactly the listed tasks.
- *Undo* reverts the last confirmed batch - including deletions and new categories - except anything
  you edited yourself in the meantime (it says so). Success is shown only after the changes were
  actually saved; otherwise the usual "could not save" notice with *Retry* appears.
- The assistant cannot run code or read files: it receives only the context below and can only
  propose the actions listed above.

**Privacy**

- *Connect* / *Reconnect* send only the key check described above. Nothing else is sent until you
  send a message. Then the app sends to the connected service only:
  your message; the current date, weekday, time and time zone; your category names; a summary
  (numbers of tasks per status, overdue, due today); the available time for day plans (if set); and
  only the existing tasks your message is about (at most 40: tasks named in it, tasks of this
  conversation, and for questions or plans the overdue / due soon / mentioned-category tasks) - their
  title, status, priority, category, deadline and time, reminders, repeat rule, estimate, planned
  slot and completion date, plus the subtasks of tasks you name or worked with.
- Descriptions, labels, all other tasks, files, paths and settings are not sent.
- The conversation is kept in memory for the current session only and is never written to disk
  (OpenAI requests are made with `store: false`). The service's own data-retention terms apply
  to what is sent.

**Security**

- The key is stored only after a successful check, and only encrypted with Windows (Electron
  `safeStorage`, DPAPI) in `%APPDATA%\Taskflow\taskflow-ai.json`, separate from the task data. It
  cannot be viewed again, only replaced or removed, and it is tied to your Windows user. If secure
  storage is unavailable, the key is not saved at all.
- Requests are made only by the app's main process, only to the connected service's official API
  (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`) or to the base URL
  you entered; environment variables cannot redirect them, redirects are not followed, and the
  window itself cannot make network requests.
- Everything the model returns is treated as untrusted and validated before you see it.

**Limitations**

- An internet connection is required (except for an OpenAI-compatible server on this computer).
- Live requests to Anthropic, OpenAI and Gemini have not been tested with real keys during
  development; all automated tests use simulated services. See TESTING.md for the manual check.
- Gemini's key check (`models.get`) shows that the key exists; Google notes that this does not
  guarantee generation is enabled, so a problem may first show up with the first message.
- If Taskflow is killed (Task Manager, power loss) right after the very first key was saved,
  Windows' protection key for it may not have been written yet; the saved key then cannot be read
  after the restart, and the settings ask for it again.
- Matching existing tasks is by words in their titles: a Russian word does not find an English
  title (and vice versa) - the assistant then says it cannot find the task.
- The assistant does not see task descriptions, so it can replace a description but not extend it.
- Token usage is shown per session as reported by the service; a cost estimate only for models whose
  price was read from the provider's documentation (OpenAI GPT-6 models). An API subscription is
  separate from a ChatGPT/Claude app subscription: requests are billed to the API key's account.
- One conversation holds up to 20 messages; then start a new conversation.
- Undo returns a task to its previous column at the end, not at its exact previous position.

Code: `electron/ai/` (settings, connection, IPC, chat service, task context, provider registry and
the adapters in `providers/`: `anthropic.cjs`, `openai.cjs`, `gemini.cjs`, `openaiCompatible.cjs`,
`shared.cjs`),
`src/ai/` (plan validation `actionPlan.js`, applying and undo `applyPlan.js`, assistant state),
`src/data/categoryMatch.js`, `src/components/AiPanel.jsx`.

**Voice input**

The microphone button next to the message box records your speech (Russian or English): click to
start, click again to stop. OpenAI (`gpt-4o-mini-transcribe`) transcribes it and the text is
inserted into the message box at the cursor, after any text already there - exactly as if typed.
**Nothing is sent automatically**: edit the text if needed and press *Send*.

- It uses the OpenAI key stored by Taskflow (encrypted): the assistant's key when the assistant uses
  OpenAI, or a key saved under AI settings → *Голосовой ввод* (checked first; the assistant keeps its
  service).
- A recording is sent to OpenAI only for transcription, only when you use the microphone. Recordings
  stop by themselves after 2 minutes; the microphone is released after each one.
- The app may use the microphone (audio only, only its own page); Windows' microphone privacy setting
  must allow desktop apps. Camera, location and notifications stay blocked.
- OpenAI lists `gpt-4o-mini-transcribe` as deprecated (shutting down on 26 Feb 2027; successor
  `gpt-transcribe`); the model id is one constant in `electron/ai/speech.cjs`.

## Due times, reminders and repeating tasks

In the task window, after setting a due date: an optional **due time**; **reminders** (at the due
time, 10 or 30 minutes, 1 hour or 1 day before; for tasks without a time: on the day, 1 or 2 days or
a week before); a **repeat** (every N days, weeks on chosen weekdays, or months on a day of the
month); and an **estimate** in minutes. Cards show the time, a repeat and a bell marker.

- The deadline (date + time), the reminders and the day-plan slot are separate: removing the time
  keeps the date (reminders that need a time are removed with it); a day plan never changes the
  deadline.
- Times are local wall-clock times: a time-zone change keeps "16:30" at 16:30, and DST is handled
  (a time that does not exist on the day clocks go forward becomes the next valid time).
- **Repeating tasks** store one rule; the task shows its next occurrence as the due date. Marking it
  done records the completion and moves it to the next occurrence (in To Do, checklist unticked);
  missed occurrences are skipped, not duplicated. Editing changes the rule; deleting deletes the
  repeating task.
- **Reminders** are desktop notifications from the main process, calculated from the saved tasks
  (not from timers in the window). Each reminder is recorded when shown, so a restart or reboot
  never repeats it; changing or deleting a task reschedules or removes its reminders. Reminders that
  were missed while the computer slept or Taskflow was closed are shown once, together, at the next
  start (if less than a day old; older ones are skipped). After Windows resumes, due reminders
  appear within a minute.
- **Limitation:** reminders appear only while Taskflow is running - closing the window quits the app,
  and there is no background service. Windows' notification settings and Focus Assist decide whether
  a banner is shown.
- *Settings* (sidebar): reminders on/off, the reminder time for tasks without a time (09:00 by
  default), and the available time for day plans.

## Installing, using and uninstalling

1. Run `Taskflow-Setup-<version>.exe`.
2. Choose the installer language, then "Only for me" (the default; no administrator rights needed)
   and, optionally, a different folder. The default folder is
   `%LOCALAPPDATA%\Programs\Taskflow`.
3. Start Taskflow from the Start Menu or the desktop shortcut.

Silent installation (for scripted setups): `Taskflow-Setup-<version>.exe /S /currentuser` (optionally
`/D=C:\path\to\Taskflow` as the last argument).

**Upgrading:** run the installer of a newer version; it replaces the application files in place.

**Uninstalling:** Windows Settings → Apps → Installed apps → Taskflow → Uninstall (or
"Uninstall Taskflow.exe" in the installation folder). The uninstaller removes the program and its
shortcuts but **keeps your data**.

## Where your data is stored

Tasks, categories and settings are saved by the Electron main process as a versioned JSON file:

```
%APPDATA%\Taskflow\taskflow-data.json        current data
%APPDATA%\Taskflow\taskflow-data.json.bak    previous save (backup)
%APPDATA%\Taskflow\taskflow-data.<reason>-<time>.json   copies kept before migrations/repairs
%APPDATA%\Taskflow\taskflow-ai.json          AI settings and the encrypted API key (only if used)
%APPDATA%\Taskflow\taskflow-reminders.json   which reminders were already shown (no task data)
```

This folder is separate from the program files. Installing, upgrading or uninstalling never
deletes it. To remove your data completely, delete the folder manually after uninstalling.
Data from older versions is upgraded automatically on first launch, and the original file is kept
(0.3.0 uses schema v4: due times, reminders, repeat rules, estimates, planned slots, completion
times). Earlier versions open v4 data read-only and never overwrite it.

## Known limitations

- **Not code-signed.** The installer and `Taskflow.exe` have no digital signature. Windows
  SmartScreen may show "Windows protected your PC" (choose *More info → Run anyway*), and on PCs with
  Smart App Control in enforcement mode unsigned apps can be blocked. Signing requires a code-signing
  certificate configured for electron-builder.
- Windows x64 only (no ARM64 or 32-bit build, no macOS/Linux packages).
- No automatic updates: newer versions are installed by running a newer installer.
- The installer is about 99 MiB because it contains the Electron (Chromium) runtime.
- Reminders appear only while Taskflow is running.
- No voice input, cloud sync, accounts or mobile apps.
