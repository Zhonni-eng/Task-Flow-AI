# Testing Taskflow

Taskflow has two layers of automated tests:

1. **Vitest + React Testing Library** (`tests/unit`, `tests/storage`, `tests/components`) — fast,
   deterministic tests that run in Node/jsdom without opening a window.
2. **Electron smoke test** (`tests/electron/smoke.mjs`) — launches the built app (development Electron
   with `dist/`, or the packaged `Taskflow.exe` with `--packaged`) in a real Electron
   window to check what jsdom cannot (window loading, Electron security, IPC, close-time saving,
   drag-and-drop with real layout).

No test ever reads or writes the real `%APPDATA%\Taskflow` folder: storage tests and the smoke test
use fresh folders inside the operating system's temp directory and delete them afterwards.

## Setup

```bash
npm install
```

Requires Node.js 22 or newer (developed with Node 24).

## Commands

| Command | What it does |
|---|---|
| `npm test` | Runs the whole Vitest suite once (unit, storage and component tests). |
| `npm run test:watch` | Vitest watch mode: re-runs affected tests when files change. |
| `npm run test:unit` | Only `tests/unit`. |
| `npm run test:storage` | Only `tests/storage`. |
| `npm run test:components` | Only `tests/components`. |
| `npm test -- tests/unit/taskView.test.js` | A single test file (any path or part of a path works). |
| `npm test -- -t "category"` | Only tests whose name matches the text. |
| `npm run build` | Production build into `dist/`. |
| `npm run test:electron` | Electron smoke test against `dist/` (run `npm run build` first). |
| `npm run test:packaged` | The same smoke test against the packaged `release/win-unpacked/Taskflow.exe` (run `npm run package:win` first). |

## What each group covers

### `tests/unit` — application logic (Node + jsdom globals)

| File | Covers |
|---|---|
| `taskModel.test.js` | Task defaults, normalization, length limits, labels, validation, editable fields, restoring saved tasks. |
| `tasksReducer.test.js` | Create/update/delete, moving and reordering, no-op drops, column renumbering, category reassignment, distinct labels. |
| `categories.test.js` | Category names (empty/duplicate), ids, restoring, create/rename/delete reducer. |
| `subtasks.test.js` | Subtask model (title trimming/validation, unique ids, cleaning and limits, no nesting, progress), task normalization and form values, reducer operations keeping subtasks with their parent (move, reorder, bulk actions, delete), subtasks never appearing as top-level tasks in search, filters or statistics. |
| `dueDates.test.js` | Due-date states (overdue/today/tomorrow/upcoming, completed never overdue, no date neutral), the Overdue/Today/Upcoming filters with search, categories, sorting and status/date changes, statistics, quick due dates including "next week" for Monday and Sunday weeks, local dates in several time zones (`process.env.TZ`), midnight and daylight-saving boundaries, and the midnight refresh hook. |
| `actionPlan.test.js` | AI action-plan validation (no execution) for every action type: create (description, deadline and time, reminders, repeat, estimate, subtasks), update (only given fields; "remove the time but keep the date"; clearing a date clears what depends on it), delete (subtasks and repeating series), subtask add/update/delete/move (unknown subtasks, moving into the same task), bulk changes resolved against the real data ("all overdue", a category, "completed older than a month"; never an empty filter, no matches), day plans (availability required, inside it, no overlaps, no invented durations, no past dates); category reuse across case, word forms and RU/EN synonyms; duplicates; no-op and repeated changes; ids not shown to the provider; unverifiable references; injected fields and types; earlier setStatus/setDueDate accepted |
| `speech.test.js` | Voice input in the main process: multipart request to `/v1/audio/transcriptions` (file + `gpt-4o-mini-transcribe`, the OpenAI key, no redirects), only the text returned; empty, unsupported and oversized recordings and a missing key send nothing; 401/429/5xx, network failures, timeouts, unexpected answers and empty transcripts; the voice key checked and stored for OpenAI without changing the assistant's service; IPC payload checks, sender check, and nothing reaching the chat. |
| `applyPlan.test.js` | Applying confirmed plans as a pure function and undoing them: the economics-exam example (title, description, three subtasks, existing category reused), one new category for a plan, moving an exam to Friday 16:30 and removing only the time, completing a repeating task (next occurrence), "move all overdue to tomorrow", "delete completed older than a month", deleting a parent with its subtasks, subtask complete/rename/add/move with ids kept, day-plan slots without touching deadlines, exact undo of created/changed/deleted tasks, and keeping tasks edited after the change. |
| `schedule.test.js` | Due times, reminder offsets (minutes need a time; whole days without one), wall-clock reminders across a DST change, date-only reminders at the set time, a non-existent DST time, deadline instants, recurrence normalization and next occurrences (daily, every N days, weekdays, every 2 weeks, monthly on the 31st and the 1st), skipping missed occurrences, completion time, the recurring-task completion in the reducer, and the batch replace action (Europe/Berlin via `TZ`). |
| `reminders.test.js` | The main-process reminder scheduler with an injected clock, timers and folder: on time and only once, not repeated after a restart (record file), rescheduling after a deadline change, deleted/completed tasks, missed reminders (recent ones shown together, old ones skipped), date-only reminders at the set time, switched off (and not "missed" when switched on again), English, the one-minute timer cap, and a restart before the window has loaded the data (records kept, nothing shown twice). |
| `anthropicAdapter.test.js` | Anthropic adapter with fake clients and with the real SDK over an injected `fetch` (no network): the connection test (one `GET /v1/models/<model>`, no messages or task data, short timeout; 401/403/404/429/5xx/529, timeout, network and unsupported responses all fail), request shape (model, cached instructions, structured-output schema, append-only history, key only in the client), plan parsing, refusals, truncation, malformed/oversized JSON, error mapping (401/403/404/429/529/5xx, timeout, network) without message text, base URL and auth token pinned against environment variables, and the global block on real requests. |
| `taskContext.test.js` | Which existing tasks are described to the assistant: Russian word forms (also two-letter case endings) and English plurals by stem, every plausible match (so it can ask), command words and dates ignored, scheduling fields and subtasks of named tasks but never descriptions or labels, pinned session tasks for follow-ups, deleted ids ignored, at most 40 tasks; group requests (overdue incl. a passed due time today, a mentioned category, day plans, completed tasks only when asked as a group) and the summary counts |
| `chatService.test.js` | Chat service: AI off / no key / unreadable key send nothing, message limits, explicit local date + weekday + time + time zone from an injected clock, only message/date/category names sent, the stored key's provider and model used, usage reported with the result, every outcome reported for the connection status, append-only history across turns, failed turns not kept, reset, one request at a time, reply after reset discarded, turn limit |
| `aiIpc.test.js` | AI IPC: exactly six channels (`get-settings`, `save-settings`, `connect`, `disconnect`, `chat`, `reset-chat`), preload surface, sender rejection on every channel, payload shape/type/size checks (settings accept only `enabled`; no provider or model choice), connect payloads rejected without any request, enabling only after connecting, chat payloads (extra fields such as a forged plan, language, message size), chat results limited to plan and shared task ids, no key, provider, model or exception text in any response. |
| `providerAdapters.test.js` | OpenAI (Responses API), Gemini (generateContent) and OpenAI-compatible (Chat Completions) adapters with a scripted fake `fetch` (`tests/helpers/fakeFetch.js`): connection-test requests (URL, method, auth header - Gemini's key never in the URL - no body, no redirects), HTTP errors (400/401/403/404/429/5xx), network failures and timeouts, unexpected answers; request shapes (instructions, strict JSON schema, `store: false`, Gemini schema conversion); normalization into the action plan; refusals, content filters, truncation, malformed JSON; history replayed unchanged (reasoning items, thought signatures); no response text or keys in errors; real requests to OpenAI and Google blocked by the test setup. |
| `aiConnection.test.js` | Provider detection (a key shape suggests one candidate; unrecognized or ambiguous keys are refused, never guessed or sent to several services), base URL rules for OpenAI-compatible APIs, provider selection (automatic and explicit, an explicit choice never falls back to another service), credential isolation (keys stored per provider, each only sent to its own service, chat going to the active one), failed attempts with another provider or another compatible configuration keeping the working one, disconnect removing every key, and the connection flow: a key is tested before it is stored; success stores it encrypted, connects and enables AI; invalid keys, permission errors, rate limits, outages, timeouts, network errors and unsupported responses never report success or store anything; locally refused keys make no request; a failed replacement key keeps the working one; one check at a time; after a restart a stored key is "saved", not "connected", until a check or chat request succeeds; keys from earlier builds are "unverified"; a rejected key becomes "failed"; disconnecting. |
| `bulkActions.test.js` | Bulk reducer actions (status with end-of-column ordering, priority/category/due date, delete with renumbering, untouched fields, no-op identity) and the List View selection hook (visible-only, pruning, clearing on category/layout change). |
| `taskView.test.js` | Search (case, `ё`/`е`, spaces), status/priority/label filters, the four sort modes, List View ordering, statistics, category scope and counts, category-scoped drag positions. |
| `saveStatus.test.js` | The save-error banner: a successful board save never hides a failed settings save (and vice versa), retry clears it only when every failed save succeeded, IPC errors and missing results count as failures. |
| `saveQueue.test.js` | One write at a time, latest snapshot wins, errors and retry. |
| `storageClient.test.js` | Renderer storage client: boot data, merged settings saves (`language` + `lastView`), read-only mode, failed saves and retry, legacy language migration, missing bridge. |
| `date.test.js` | Date-key parsing and arithmetic with a controlled clock. |
| `i18n.test.js` | Russian/English dictionaries have identical keys, placeholders and plural forms; every `t('…')` key used in `src/` exists. |

### `tests/storage` — main-process JSON storage (Node environment)

`storage.test.js` exercises `electron/storage.cjs` on real files in temp folders: first launch,
round-trips of tasks/categories/settings, backups, v1→v2 and unversioned migration (ids, order,
labels, dates and settings preserved), newer-version read-only mode, corrupt files and recovery,
invalid records and category references, atomic writes, failed and retried renames (simulated
`ENOSPC`/`EACCES`/`EBUSY`), independent settings updates, remembered view fallback, and reloads
returning the latest data, and a file starting with a UTF-8 BOM.

`subtasks-migration.test.js` covers schema v3: v2→v3 migration adding empty subtask lists (original
file kept byte-for-byte, migration repeatable), the v1→v2→v3 chain, subtask round-trips, repair of
invalid subtasks and unknown fields, read-only mode for newer files, and whitespace collapsing in
category names and subtask titles.

`aiSettings.test.js` covers `electron/ai/aiSettings.cjs` with a fake `safeStorage` (`tests/helpers/fakeSafeStorage.js`): AI off by default, nothing written until a change, no provider or model in the public state, verified keys stored only encrypted (with the time of the check) and never returned, key format checks, no plaintext fallback when secure storage is unavailable (or Linux `basic_text`), keys that cannot be decrypted, encryption that does not round-trip, enabling only with a verified key, files of earlier 0.3.0 builds (old `model` field ignored, untested key cannot enable AI), failed writes keeping the previous key, corrupt/repaired/oversized/newer-version files, and the task data file left untouched.

`integrity.test.js` checks that storage and the renderer agree on every value (anything the renderer
would change is reported as a repair with a copy of the original; normalization is idempotent),
that unknown fields at any level are never dropped silently, that a damaged or newer-version backup
is preserved before backups rotate, full-field v1→v3 and v2→v3 migrations (repeatable, clean on the
next launch), and category names with spaces, Latin, Cyrillic and punctuation round-tripping.

### `tests/components` — real UI behavior (jsdom + React Testing Library)

The whole app is rendered exactly as in `src/main.jsx` (`AppRoot` in `StrictMode`). Only the
Electron preload bridge is replaced: it calls the **real** `electron/storage.cjs` on a temp folder,
with data passing through `structuredClone` like Electron IPC (see `tests/helpers/renderApp.jsx`).

| File | Covers |
|---|---|
| `tasks.test.jsx` | Creating (all fields, validation, unconfirmed label), editing, cancelling, deleting (card and dialog), unsaved-edit confirmation on Escape and backdrop click, Escape in the calendar. |
| `categories.test.jsx` | Creating/renaming (sidebar and header), name validation, All tasks/category/Uncategorized navigation, counts, assignment and defaults, category deletion with reassignment, remembered view after restart and its fallback. |
| `views.test.jsx` | Board/List switching, List View status changes, edit/delete from the list, search, filters with chips, sorting without changing saved order, statistics, empty and no-match states. |
| `subtasks.test.jsx` | Adding, editing, toggling and deleting subtasks in the task dialog, empty/whitespace titles rejected, keyboard use (Enter, focus), cancel discarding changes, progress on Board cards and in List View (none without subtasks), parent and subtask completion staying independent, bulk actions and parent deletion, persistence after restart, English, accessible names. |
| `dueDates.test.jsx` | Due-date indicators on Board cards and in List View (text and icon, not color alone), completed and undated tasks, quick due dates in the editor and bulk toolbar, clearing a due date, date filters updating after edits and status changes, combined with search, categories, sorting and bulk selection, subtasks left untouched, Russian and English. |
| `focusAndPolish.test.jsx` | Keyboard focus after removals (task deleted from card, dialog or list row moves focus to the next/previous task or "New task"; bulk actions, bulk delete and "Clear selection" focus the select-all checkbox; category deletion focuses "All tasks"; cancel returns to the delete button), edit icons kept out of the Tab order, category tag label and tooltip, partial and disabled select-all, focused board controls scrolled into view (not during drags), and the reduced-motion hook. |
| `crossFeature.test.jsx` | Stages 1–4 together: bulk updates on tasks with subtasks and due dates, deleting parents individually and in bulk, editing due dates under active date filters and search, Board/List switches with filters and sort, status changes under a sort (stable ids, subtasks, dense order), deleting a category in use with a selection, language changes mid-workflow, save errors during edits and bulk updates (reported, retried, focus kept), dismissing a startup notice, and a full-field task surviving a restart. |
| `assistant.test.jsx` | Assistant panel end to end with the real IPC, chat service and adapter (scripted fake SDK client): AI off/not configured, Russian and English multi-task proposals, review details, duplicates unticked by default, invalid proposals not selectable, decline, clarifying questions, re-check against current data before applying, save failure reported as not saved (never success) and Retry, Undo, no double submission, error messages (401, 429, refusal, truncation, malformed), what is and is not sent, conversation context and New conversation, closing/Escape/focus. |
| `assistantUpdates.test.jsx` | Status and due-date changes end to end: review (from → to), apply and save, only relevant tasks sent, no-op changes unticked, English follow-up that clears a due date, mixed create + change, ambiguous matches answered with a question, ids never shown or made up rejected, conflicting changes unticked and blocked, stale (deleted) tasks, malformed change lists, Undo (exact restore, and keeping the user's edits made in between), failed saves, AI switched off, New conversation forgetting shared tasks. |
| `aiSettings.test.jsx` | AI connection settings through the real app, settings store and connection (scripted fake SDK client and fake `fetch`): only a key field, Connect / Reconnect, status, on/off and Disconnect in the default view - provider choice and OpenAI-compatible fields only in the collapsed Advanced section; an unrecognized key sent nowhere, Advanced opened, then connected with an explicit Gemini choice; an OpenAI key recognized automatically; OpenAI-compatible address/model validation, connection and the saved configuration shown again; Connect success (one test request, field cleared, "Подключено", AI on, key never in the page, the API or the file); rejected keys, network errors, timeouts, rate limits and outages ("Не удалось подключиться" with the reason, nothing stored, focus back in the field); unsupported and empty keys without any request; a failed replacement keeping the working key; "Ключ сохранён" after a restart until Reconnect checks it; switching off/on; Disconnect; unavailable secure storage; corrupt settings file; Escape and focus; tasks untouched; English. |
| `assistantManage.test.jsx` | Full task management end to end (scripted fake SDK client): a bulk change listing every affected task with the count, applied and undone; a bulk change matching nothing cannot be applied; deleting a task with subtasks and getting it back with Undo; an existing category reused under another name, a new category created on confirm and removed by Undo; completing one subtask by id; "What is overdue?" answered from the context sent; a clarifying question instead of a guess; day plans blocked without availability and applied as planned slots with it. |
| `voiceInput.test.jsx` | Voice input with a simulated microphone: text inserted after existing text and at the cursor, English too, never sent (no request, no message, Send untouched), editable afterwards, microphone released; permission denied, too short recordings, rejected key, network failure and empty transcripts with clear messages and the box unchanged; no OpenAI key; saving a voice key without changing the assistant's service; the insertion helper. |
| `scheduleUi.test.jsx` | Due time, reminders, weekly repeat and estimate in the task window and on the card; removing the time keeps the date and drops minute reminders; fields disabled without a due date; a passed due time today shows as overdue; Settings for reminders and day-plan availability (with validation). |
| `bulkActions.test.jsx` | List View multi-selection and bulk actions: single/multiple/select-all, search, filters and categories narrowing the selection, sorting keeping it, clearing on context change, status/complete/category/priority/due date/delete (confirm and cancel), unchanged unselected tasks, persistence after restart, English, accessible names. |
| `feedback-a11y.test.jsx` | Notifications (auto-dismiss with fake timers, close button), failed-save notice and retry, recovery and read-only notices, error fallback with safe reload, accessible names for all controls, icon-only switcher, Tab reachability, calendar and filter keyboard behavior, Ctrl+F, English interface and remembered language. |

Every test runs with real requests to AI providers blocked (`tests/setup/setup.js`); AI tests use
`tests/helpers/fakeAnthropic.js` (scripted SDK client) and `tests/helpers/fakeSafeStorage.js`.

Time-dependent tests use a fixed date (21 October 2026) through `vi.setSystemTime` with only `Date`
faked, so due dates, "overdue" and statistics are stable on any day.

## Pointer drag-and-drop runs in a real window

Scripted mouse drags (DevTools input) can be disturbed by the real mouse moving over the test
window. Measured on 2026-10-24: with OS input to the test window blocked (`EnableWindow(false)`),
5 of 5 runs passed all 62 checks while the real cursor was active (and over the window 41 times);
with input enabled, a run failed only when the cursor was over the window for a while. Run such
suites with the window's OS input blocked, or without touching the mouse. The permanent smoke test
uses a keyboard drag and is not affected.

## What needs a real Electron window

jsdom has no layout engine, no real `<dialog>` top layer and no Electron runtime. These checks run
only in a real window (`npm run test:electron`, or manually):

- Pointer and keyboard **drag-and-drop** (dnd-kit measures element positions). The ordering logic
  behind it is unit-tested; the smoke test performs a real keyboard drag.
- **Electron security**: `contextIsolation`, no `nodeIntegration`, the restricted preload API and
  the content security policy of the production build.
- **IPC and the close handshake**: saving through `ipcMain`, flushing pending saves when the window
  closes, and the sender check on IPC handlers. The smoke test also checks that navigating to any
  other local file is blocked (only the app's own `dist/index.html` may load or use storage), that
  AI is off and not connected by default with no provider or model visible to the page, and that
  unrecognized or malformed keys and non-HTTPS addresses are refused locally (no request, nothing
  stored). Storing a key needs
  a successful connection test, i.e. the network, so the smoke test does not store one; the encrypted
  round trip is covered by unit tests and by step 2 of the manual check below.
- **Encryption across restarts**: Electron keeps the key that protects stored secrets in the profile's
  `Local State` file and writes it when the app exits normally. If Taskflow is killed (Task Manager,
  power loss) right after the first key was saved, the saved key cannot be decrypted after the
  restart; the settings then say so ("Сохранённый ключ не читается") and ask for the key again.
- **Visual and layout behavior**: CSS is not loaded in jsdom, so focus rings, contrast, narrow-window
  layouts and the icon-only switcher's appearance were verified in Electron during Stage 6.
- **Native `<dialog>` focus trapping and inert background**: jsdom uses a small polyfill
  (`tests/setup/dialogPolyfill.js`) that reproduces open/close/Escape behavior only.

## Manual live check of the AI assistant

Automated tests never contact Anthropic: requests to Anthropic hosts are blocked in every test, and the
AI tests use scripted clients (requests to Anthropic, OpenAI and Google hosts are blocked in every
test). Whether a real key works can only be checked by hand, with your own key, in the separate test
data folder (never your real data). Repeat step 2 for each service you use (an OpenAI `sk-…` key, a
Google AI Studio key - choose *Google Gemini* under *Дополнительно* if it is not recognized - or an
OpenAI-compatible server under *Дополнительно*), then send one message (step 3) to confirm that
requests and structured answers work with that service:

1. Double-click `Run-Taskflow.bat` in this project folder (data in `%LOCALAPPDATA%\Taskflow Dev`; the banner
   must show this folder and the current version).
2. Sparkle button → *Настройки ИИ* → paste your API key → *Подключить*. Expected:
   "Подключено" and the assistant switched on. Paste a key with one character changed → *Переподключить*:
   expected "Не удалось подключиться. Ключ не принят…" and "Прежний ключ сохранён…", status still
   "Подключено". Close Taskflow normally and start it again: the status is "Ключ сохранён" with the
   time of the last check; *Переподключить* with an empty field shows "Подключено" again.
3. Send "Завтра купить продукты и забрать посылку". Expected: two proposed tasks dated tomorrow.
   Press *Создать 2 задачи*; both appear on the board; then *Отменить создание* removes them.
4. Create a task "Подготовить отчёт" by hand. Send "Отчёт готов" → a status change *К выполнению →
   Готово*; apply it. Send "Перенеси его на пятницу" → a due-date change; apply. Send "убери срок" →
   the due date is cleared after you apply.
5. Create "Позвонить маме" and "Позвонить папе" by hand, then send "Позвонить — готово". Expected: a
   question asking which one, and nothing proposed.
6. Decline one proposal (*Не создавать*): nothing changes.
7. In *Настройки ИИ* press *Отключить и удалить ключ*: expected "Не подключено", the assistant is off and
   the message box is disabled. Connect again with your key afterwards if you want to keep using it.
8. Switch the assistant off and send a message: expected "ИИ-помощник выключен"; no request is made.

Requests are billed by Anthropic to the key's account; this procedure uses only a few short requests.

## Manual checks of reminders and the new assistant abilities

Automated tests drive the reminder scheduler with a fake clock, and a live check ran the packaged
app (a reminder due a minute after start fired on time, a missed one was handled once, nothing
repeated after a restart). Whether Windows shows the banner depends on its notification settings, so
check once by hand with `Run-Taskflow.bat`:

1. Create a task due today at a time 11 minutes from now with the reminder "За 10 минут" (or a time
   2 minutes from now with "В момент срока"). Expected: a Windows notification "Напоминание: …" at
   the reminder time; clicking it shows Taskflow.
2. Close Taskflow before the next reminder is due and start it again 5 minutes later. Expected: one
   "Пропущенные напоминания" notification; restarting again shows nothing more.
3. Mark a repeating task done: it moves to its next occurrence in To Do.
4. With your API key: "Перенеси экзамен на пятницу в 16:30", "Убери время, но оставь дату",
   "Перенеси все просроченные на завтра" (check the listed tasks before applying, then Undo),
   "Что у меня просрочено?", "Составь план на завтра" (with and without available time in Settings).

## Manual check of voice input

Automated tests use a simulated microphone and a simulated OpenAI. A live run with a synthesized
English WAV as the microphone (Chromium's fake capture) reached OpenAI, but the saved key was rejected
(401), and this PC has no Russian voice - so check by hand with a working OpenAI key:

1. `Run-Taskflow.bat` → assistant → type "Черновик:" → click the microphone → say
   "Перенеси экзамен на пятницу в шестнадцать тридцать" → click again. Expected: the text appears
   after "Черновик:", stays editable, nothing is sent.
2. The same in English ("Move my exam to Friday at four thirty").
3. Deny the microphone in Windows privacy settings: a clear message, nothing recorded.

## Running the whole suite

`vitest.config.js` limits Vitest to 4 workers: with all 16 workers of the build machine, parallel jsdom
tests starved each other (a test that takes 1.6 s alone took up to 15 s and hit the timeout); with 4
the slowest takes about 4 s and the run is only slightly longer.

## Notes for writing tests

- Prefer queries by role and accessible name (`getByRole('button', { name: 'Новая задача' })`).
- Use `renderApp({ document })` to start from specific saved data and `renderApp({ temp })` to
  simulate a restart with the same folder.
- Wait for persistence with `waitFor(() => expect(env.readData()…))` instead of fixed delays.
- Builders in `tests/helpers/fixtures.js` return fresh objects; never share mutable data between tests.
