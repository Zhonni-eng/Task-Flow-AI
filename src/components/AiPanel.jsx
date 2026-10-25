import { useEffect, useId, useRef, useState } from 'react';
import { editLabels } from '../ai/actionPlan.js';
import { getAiSettings } from '../ai/aiSettingsClient.js';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { insertAtSelection, useVoiceInput } from '../ai/useVoiceInput.js';
import { recurrenceLabel, reminderLabel } from '../data/scheduleText.js';
import { parseDateKey } from '../utils/date.js';
import { CloseIcon, MicIcon, SparkleIcon } from './Icons.jsx';

const MAX_MESSAGE_LENGTH = 2000;
// Error codes with their own text; anything else is shown as a generic failure.
const KNOWN_ERRORS = ['AI_DISABLED', 'NO_KEY', 'AUTH', 'PERMISSION', 'RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'OVERLOADED', 'MODEL_UNAVAILABLE', 'REFUSED', 'TRUNCATED', 'MALFORMED', 'CONVERSATION_LIMIT', 'INVALID_MESSAGE', 'BUSY', 'UNAVAILABLE'];
const errorKey = (code) => `assistant.errors.${KNOWN_ERRORS.includes(code) ? code : 'generic'}`;
// Voice input errors with their own text.
const VOICE_ERRORS = [
  'MIC_DENIED', 'NO_MIC', 'MIC_BUSY', 'MIC_ERROR', 'EMPTY_RECORDING', 'EMPTY_TRANSCRIPT', 'NO_SPEECH_KEY', 'RECORDING_TOO_LONG', 'AUTH', 'PERMISSION',
  'MODEL_UNAVAILABLE', 'RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'OVERLOADED', 'PROVIDER_ERROR', 'TRUNCATED_TEXT',
];
const voiceErrorKey = (code) => `assistant.voice.errors.${VOICE_ERRORS.includes(code) ? code : 'generic'}`;

const MAX_LISTED = 10;
const WARNING_NOTES = {
  possibleDuplicate: 'assistant.duplicate',
  duplicateInPlan: 'assistant.duplicateInPlan',
  noChange: 'assistant.noChange',
  advancesRecurrence: 'assistant.advancesRecurrence',
  deletesSeries: 'assistant.deletesSeries',
  noMatches: 'assistant.noMatches',
  noEstimate: 'assistant.noEstimate',
  afterDeadline: 'assistant.afterDeadline',
  timeKeepsDates: 'assistant.timeKeepsDates',
  labelLimit: 'assistant.labelLimit',
};

/** Texts for one review item: { kind, title, details: string[], list: string[], notes: string[] }. */
function describeEntry(t, formatDate, entry, raw, categories) {
  const shortDate = (key) => {
    const date = key ? parseDateKey(key) : null;
    return date ? formatDate(date, { weekday: 'short', day: 'numeric', month: 'long' }) : t('assistant.noDueDate');
  };
  const categoryName = (id) => (id ? categories.find((category) => category.id === id)?.name ?? '?' : t('assistant.field.noCategory'));
  const categoryText = (id, newName) => (newName ? t('assistant.field.newCategory', { name: newName }) : categoryName(id));
  const remindersText = (list, timed) => (list?.length ? list.map((offset) => reminderLabel(t, offset, timed).toLocaleLowerCase()).join(', ') : t('assistant.field.none'));
  const estimateText = (minutes) => (minutes ? t('task.estimate', { count: minutes }) : t('assistant.field.none'));
  const n = entry.normalized;
  const target = entry.target;
  const details = [];
  const list = [];
  const notes = [];
  const listTasks = (matched) => {
    list.push(...matched.slice(0, MAX_LISTED).map((task) => (task.dueDate ? `${task.title} (${shortDate(task.dueDate)})` : task.title)));
    if (matched.length > MAX_LISTED) list.push(t('assistant.bulkMore', { count: matched.length - MAX_LISTED }));
  };
  let kind = t(`assistant.kind.${entry.type === 'create' ? 'create' : 'unknown'}`);
  let title = entry.type === 'create' ? (typeof raw?.title === 'string' ? raw.title : t('assistant.untitled')) : target?.title ?? t('assistant.unknownTask');

  /** One line per changed field ("Срок: 23 окт. → 25 окт."). */
  const changeLines = (changes, newCategory, before) => {
    const lines = [];
    if ('title' in changes) lines.push(t('assistant.field.title', { from: before?.title ?? '', to: changes.title }));
    if ('status' in changes) lines.push(t('assistant.statusChange', { from: before ? t(`columns.${before.status}`) : '?', to: t(`columns.${changes.status}`) }));
    if ('dueDate' in changes) lines.push(t('assistant.dueChange', { from: shortDate(before?.dueDate), to: shortDate(changes.dueDate) }));
    if ('dueTime' in changes) lines.push(t('assistant.field.time', { from: before?.dueTime ?? t('assistant.field.none'), to: changes.dueTime ?? t('assistant.field.none') }));
    if ('priority' in changes) lines.push(t('assistant.field.priority', { from: before ? t(`priority.${before.priority}`) : '?', to: t(`priority.${changes.priority}`) }));
    if ('categoryId' in changes || newCategory) lines.push(t('assistant.field.category', { from: categoryName(before?.categoryId), to: categoryText(changes.categoryId, newCategory) }));
    if ('description' in changes) lines.push(changes.description ? t('assistant.field.description', { to: changes.description }) : t('assistant.field.descriptionCleared'));
    if ('reminders' in changes) lines.push(t('assistant.field.reminders', { to: remindersText(changes.reminders, Boolean(changes.dueTime ?? before?.dueTime)) }));
    if ('recurrence' in changes) lines.push(t('assistant.field.recurrence', { to: changes.recurrence ? recurrenceLabel(t, changes.recurrence) : t('schedule.noRepeat') }));
    if ('estimateMinutes' in changes) lines.push(t('assistant.field.estimate', { to: estimateText(changes.estimateMinutes) }));
    if ('planned' in changes) lines.push(t('assistant.field.planned'));
    const labelText = (labels) => (labels?.length ? labels.join(', ') : t('assistant.field.none'));
    if (before && (changes.addLabels || changes.removeLabels)) {
      lines.push(t('assistant.field.labels', { from: labelText(before.labels), to: labelText(editLabels(before.labels, changes.addLabels, changes.removeLabels)) }));
    } else {
      if (changes.addLabels) lines.push(t('assistant.field.addLabels', { list: changes.addLabels.join(', ') }));
      if (changes.removeLabels) lines.push(t('assistant.field.removeLabels', { list: changes.removeLabels.join(', ') }));
    }
    return lines;
  };

  switch (entry.type) {
    case 'create': {
      const fields = n?.fields;
      title = fields?.title || title;
      // Date, priority, status and category on one line ("Срок: чт, 22 октября · Высокий · Дом").
      const head = [];
      if (fields?.dueDate) head.push(t('assistant.due', { date: fields.dueTime ? t('task.dateTime', { date: shortDate(fields.dueDate), time: fields.dueTime }) : shortDate(fields.dueDate) }));
      if (fields && fields.priority !== 'medium') head.push(t(`priority.${fields.priority}`));
      if (fields && fields.status !== 'todo') head.push(t(`columns.${fields.status}`));
      if (n?.newCategory) head.push(t('assistant.field.newCategory', { name: n.newCategory }));
      else if (fields?.categoryId) head.push(categoryName(fields.categoryId));
      if (head.length > 0) details.push(head.join(' · '));
      if (fields?.recurrence) details.push(t('task.repeats', { rule: recurrenceLabel(t, fields.recurrence) }));
      if (fields?.reminders?.length) details.push(t('task.hasReminders', { list: remindersText(fields.reminders, Boolean(fields.dueTime)) }));
      if (fields?.estimateMinutes) details.push(estimateText(fields.estimateMinutes));
      if (fields?.description) details.push(t('assistant.field.description', { to: fields.description }));
      if (fields?.subtasks?.length) details.push(t('assistant.subtasks', { list: fields.subtasks.join(', ') }));
      if (fields?.labels?.length) details.push(t('assistant.field.newLabels', { list: fields.labels.join(', ') }));
      break;
    }
    case 'update': {
      const changes = n?.changes ?? raw?.changes ?? {};
      const keys = Object.keys(changes);
      kind = keys.length === 1 && keys[0] === 'status' ? t('assistant.kind.setStatus') : keys.length === 1 && keys[0] === 'dueDate' ? t('assistant.kind.setDueDate') : t('assistant.kindMore.update');
      if (n) details.push(...changeLines(changes, n.newCategory, target));
      break;
    }
    case 'delete':
      kind = t('assistant.kindMore.delete');
      details.push(t('assistant.deleteTask'));
      if (target?.subtasks?.length) details.push(t('assistant.deletesSubtasks', { count: target.subtasks.length }));
      break;
    case 'addSubtask':
      kind = t('assistant.kindMore.addSubtask');
      details.push(t('assistant.subtaskAdd', { title: n?.title ?? raw?.title ?? '' }));
      break;
    case 'updateSubtask': {
      kind = t('assistant.kindMore.updateSubtask');
      const parts = [];
      if (n?.changes && 'done' in n.changes) parts.push(t(n.changes.done ? 'assistant.subtaskDone' : 'assistant.subtaskOpen'));
      if (n?.changes?.title) parts.push(t('assistant.subtaskRename', { title: n.changes.title }));
      details.push(`«${entry.subtask?.title ?? '?'}»: ${parts.join(', ')}`);
      break;
    }
    case 'deleteSubtask':
      kind = t('assistant.kindMore.deleteSubtask');
      details.push(t('assistant.subtaskDelete', { title: entry.subtask?.title ?? '?' }));
      break;
    case 'moveSubtask':
      kind = t('assistant.kindMore.moveSubtask');
      details.push(t('assistant.subtaskMove', { title: entry.subtask?.title ?? '?', to: entry.destination?.title ?? '?' }));
      break;
    case 'bulk': {
      kind = t(raw?.operation === 'delete' ? 'assistant.kindMore.bulkDelete' : 'assistant.kindMore.bulk');
      const matched = entry.matchedTasks ?? [];
      // An invalid bulk change resolved no tasks: never present that as "affects 0 tasks".
      title = entry.valid ? t('assistant.bulkCount', { count: matched.length }) : t('assistant.bulkUnresolved');
      if (n?.filter?.scope === 'all') details.push(t('assistant.bulkAll'));
      if (n && raw?.operation === 'update') details.push(...changeLines(n.changes, n.newCategory, null).map((line) => line.replace(/^([^:]+): [^→]*→ /, '$1: ')));
      if (raw?.operation === 'delete') details.push(t('assistant.bulkDeleteNote'));
      listTasks(matched);
      break;
    }
    case 'renameLabel':
    case 'deleteLabel': {
      // A tag exists only on tasks: renaming or deleting it changes every task that has it.
      const rename = entry.type === 'renameLabel';
      const label = n?.label ?? raw?.label ?? '';
      kind = t(rename ? 'assistant.kindMore.renameLabel' : 'assistant.kindMore.deleteLabel');
      title = rename ? t('assistant.labelRename', { from: label, to: n?.newLabel ?? raw?.newLabel ?? '' }) : t('assistant.labelName', { label });
      details.push(t(rename ? 'assistant.labelRenameNote' : 'assistant.labelDeleteNote'));
      const matched = entry.matchedTasks ?? [];
      if (matched.length > 0) details.push(t('assistant.bulkCount', { count: matched.length }));
      listTasks(matched);
      break;
    }
    case 'schedule':
      kind = t('assistant.kindMore.schedule');
      title = t('assistant.scheduleFor', { date: shortDate(n?.date ?? raw?.date) });
      for (const item of n?.items ?? []) {
        const end = item.endMin === null ? null : `${String(Math.floor(item.endMin / 60) % 24).padStart(2, '0')}:${String(item.endMin % 60).padStart(2, '0')}`;
        list.push(end ? t('assistant.scheduleItem', { start: item.start, end, title: item.title }) : t('assistant.scheduleItemOpen', { start: item.start, title: item.title }));
      }
      details.push(t('assistant.scheduleNote'));
      break;
    default:
      break;
  }
  if (['addSubtask', 'updateSubtask', 'deleteSubtask', 'moveSubtask'].includes(entry.type) && target) details.unshift(t('assistant.inTask', { title: target.title }));
  for (const [warning, key] of Object.entries(WARNING_NOTES)) if (entry.warnings.includes(warning)) notes.push(t(key));
  return { kind, title, details, list, notes };
}

function ProposalItem({ item, categories, onToggle, disabled }) {
  const { t, formatDate } = useI18n();
  const { entry } = item;
  const { kind, title, details, list, notes } = describeEntry(t, formatDate, entry, item.raw, categories);
  const checkboxId = useId();
  const notesId = useId();
  const invalidKey = entry.type === 'create' ? 'assistant.invalid' : 'assistant.invalidChange';

  return (
    <li className={`ai-proposal__item${item.selectable ? '' : ' is-invalid'}`}>
      <input
        id={checkboxId}
        type="checkbox"
        className="task-list__checkbox"
        checked={item.selected}
        disabled={disabled || !item.selectable}
        // An explicit name reads as separate parts ("New task: Title. Due …"); warnings are its description.
        aria-label={[`${kind}: ${title}`, ...details, ...list].filter(Boolean).join('. ')}
        aria-describedby={notesId}
        onChange={() => onToggle(item.index)}
      />
      <label htmlFor={checkboxId} className="ai-proposal__text">
        <span className="ai-proposal__kind">{kind}</span>
        <span className="ai-proposal__title">{title}</span>
        {details.map((line, index) => (
          <span key={index} className="ai-proposal__meta">
            {line}
          </span>
        ))}
        {list.length > 0 && (
          <ul className="ai-proposal__affected">
            {list.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
        <span id={notesId} className="ai-proposal__notes">
          {!item.supported && <span className="ai-proposal__warning">{t('assistant.notSupported')}</span>}
          {item.supported && !entry.valid && (
            <span className="ai-proposal__warning">{t(invalidKey, { reasons: entry.errors.map((code) => t(`assistant.reasons.${code}`)).join(', ') })}</span>
          )}
          {item.conflict && <span className="ai-proposal__warning">{t('assistant.conflict')}</span>}
          {notes.map((note) => (
            <span key={note} className="ai-proposal__warning">
              {note}
            </span>
          ))}
        </span>
      </label>
    </li>
  );
}

/** Outcome text: never claims success unless the save succeeded. */
function resultText(t, result) {
  if (result.kind === 'applied') {
    const deleted = result.deleted ?? 0;
    if (!result.saved) return t('assistant.appliedNotSaved', { count: result.created + result.updated + deleted });
    if (deleted > 0) return t('assistant.appliedAll', { created: result.created, updated: result.updated, deleted });
    return result.updated === 0 ? t('assistant.applied', { count: result.created }) : t('assistant.appliedSummary', { created: result.created, updated: result.updated });
  }
  if (!result.saved) return t('assistant.undoneNotSaved', { count: result.removed + result.restored });
  const main = result.restored === 0 ? t('assistant.undone', { count: result.removed }) : t('assistant.undoneSummary', { removed: result.removed, restored: result.restored });
  return result.kept > 0 ? `${main} ${t('assistant.undoKept', { count: result.kept })}` : main;
}

function Proposal({ message, assistant, categories }) {
  const { t } = useI18n();
  const { proposal } = message;
  const selectedItems = proposal.items.filter((item) => item.selected);
  const selected = selectedItems.length;
  const onlyCreates = selectedItems.every((item) => item.entry.type === 'create');
  const anySelectable = proposal.items.some((item) => item.selectable);
  const result = proposal.result;
  const locked = proposal.status !== 'pending' || assistant.applying;
  const canUndo = assistant.undoBatch?.messageId === message.id;

  return (
    <div className="ai-proposal">
      <p className="ai-proposal__heading">
        {proposal.items.every((item) => item.entry.type === 'create') ? t('assistant.reviewTitle', { count: proposal.items.length }) : t('assistant.reviewChanges', { count: proposal.items.length })}
      </p>
      <ul className="ai-proposal__list">
        {proposal.items.map((item) => (
          <ProposalItem key={item.index} item={item} categories={categories} disabled={locked} onToggle={(index) => assistant.toggle(message.id, index)} />
        ))}
      </ul>
      {(result?.kind === 'changed' || result?.kind === 'conflict') && (
        <p className="ai-proposal__status is-error" role="alert">
          {t(result.kind === 'changed' ? 'assistant.changed' : 'assistant.conflictBlocked')}
        </p>
      )}
      {proposal.status === 'pending' && (
        <div className="ai-proposal__actions">
          {anySelectable && (
            <button type="button" className="btn btn--sm btn--primary" disabled={assistant.applying || selected === 0} onClick={() => assistant.apply(message.id)}>
              {t(onlyCreates ? 'assistant.create' : 'assistant.applySelected', { count: selected })}
            </button>
          )}
          <button type="button" className="btn btn--sm btn--ghost" disabled={assistant.applying} onClick={() => assistant.dismiss(message.id)}>
            {t('assistant.dismiss')}
          </button>
        </div>
      )}
      {proposal.status === 'dismissed' && <p className="ai-proposal__status">{t('assistant.dismissed')}</p>}
      {(result?.kind === 'applied' || result?.kind === 'undone') && (
        <p className={`ai-proposal__status${result.saved ? '' : ' is-error'}`} role="status">
          {resultText(t, result)}
        </p>
      )}
      {canUndo && (
        <button type="button" className="btn btn--sm btn--ghost" disabled={assistant.applying} onClick={assistant.undo}>
          {t(proposal.items.some((item) => item.selected && item.entry.type !== 'create') ? 'assistant.undoAll' : 'assistant.undo')}
        </button>
      )}
    </div>
  );
}

/**
 * Assistant side panel. Non-modal: the board stays usable. Closing it keeps the conversation for
 * this session (it lives in App), and never touches tasks.
 */
export default function AiPanel({ assistant, categories, onClose, onOpenSettings, settingsVersion }) {
  const { t } = useI18n();
  const [status, setStatus] = useState(null); // AI settings state, or { unavailable: true }
  const [draft, setDraft] = useState('');
  const [voiceNote, setVoiceNote] = useState(null);
  const caretRef = useRef(null);
  // Recognized speech goes into the message box at the cursor - as if typed. It is never sent here.
  const voice = useVoiceInput({
    onText: (text) => {
      const box = inputRef.current;
      setDraft((current) => {
        const result = insertAtSelection(current, text, box?.selectionStart, box?.selectionEnd, MAX_MESSAGE_LENGTH);
        caretRef.current = result.caret;
        setVoiceNote(result.truncated ? 'TRUNCATED_TEXT' : null);
        return result.value;
      });
    },
  });

  // After an insertion, put the cursor right after the inserted text so the user can edit on.
  useEffect(() => {
    if (caretRef.current === null || !inputRef.current) return;
    inputRef.current.focus();
    inputRef.current.setSelectionRange(caretRef.current, caretRef.current);
    caretRef.current = null;
  }, [draft]);
  const inputRef = useRef(null);
  const settingsButtonRef = useRef(null);
  const focusedOnOpen = useRef(false);
  const logRef = useRef(null);
  const headingId = useId();
  const inputId = useId();

  useEffect(() => {
    let cancelled = false;
    getAiSettings().then((result) => {
      if (!cancelled) setStatus(result.state ?? { unavailable: true });
    });
    return () => {
      cancelled = true;
    };
  }, [settingsVersion]);


  useEffect(() => {
    logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight });
  }, [assistant.messages, assistant.sending]);

  const ready = status && !status.unavailable && status.enabled && status.key === 'stored';

  // Once it is known whether the assistant can be used, move focus into the panel: to the message
  // box when it is ready, otherwise to "Open AI settings" (the message box is disabled then).
  useEffect(() => {
    if (!status || focusedOnOpen.current) return;
    focusedOnOpen.current = true;
    (ready ? inputRef.current : settingsButtonRef.current)?.focus();
  }, [status, ready]);

  const submit = async (event) => {
    event.preventDefault();
    if (!ready || assistant.sending || !draft.trim()) return;
    const text = draft;
    setDraft('');
    await assistant.send(text);
    inputRef.current?.focus();
  };

  return (
    <aside
      className="ai-panel"
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="ai-panel__header">
        <SparkleIcon size={18} className="ai-panel__icon" />
        <div className="ai-panel__titles">
          <h2 id={headingId} className="ai-panel__title">
            {t('assistant.title')}
          </h2>
        </div>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onOpenSettings}>
          {t('ai.settings')}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label={t('assistant.newConversation')}
          title={t('assistant.newConversation')}
          disabled={assistant.messages.length === 0 || assistant.sending || assistant.applying}
          onClick={assistant.reset}
        >
          <span aria-hidden="true">↺</span>
        </button>
        <button type="button" className="icon-btn icon-btn--sm" aria-label={t('assistant.close')} title={t('assistant.close')} onClick={onClose}>
          <CloseIcon size={16} />
        </button>
      </header>

      <div className="ai-panel__log" ref={logRef} role="log" aria-live="polite" aria-busy={assistant.sending}>
        {status && !ready && (
          <div className="ai-panel__notice">
            <p>{t(status.unavailable ? 'assistant.unavailable' : status.key !== 'stored' ? 'assistant.notConfigured' : 'assistant.disabled')}</p>
            {!status.unavailable && (
              <button type="button" ref={settingsButtonRef} className="btn btn--sm btn--primary" onClick={onOpenSettings}>
                {t('assistant.openSettings')}
              </button>
            )}
          </div>
        )}
        {ready && assistant.messages.length === 0 && (
          <div className="ai-panel__empty">
            <p>{t('assistant.empty')}</p>
            <p className="ai-panel__examples">{t('assistant.examples')}</p>
            <p className="ai-panel__privacy">{t('assistant.privacy')}</p>
          </div>
        )}
        {assistant.messages.map((message) => {
          if (message.role === 'user') {
            return (
              <div key={message.id} className="ai-msg ai-msg--user">
                <span className="visually-hidden">{t('assistant.you')}: </span>
                {message.text}
              </div>
            );
          }
          if (message.role === 'error') {
            return (
              <div key={message.id} className="ai-msg ai-msg--error" role="alert">
                {t(errorKey(message.code))}
              </div>
            );
          }
          return (
            <div key={message.id} className="ai-msg ai-msg--assistant">
              <span className="visually-hidden">{t('assistant.title')}: </span>
              {message.reply && <p className="ai-msg__text">{message.reply}</p>}
              {message.question && <p className="ai-msg__question">{message.question}</p>}
              {message.proposal && <Proposal message={message} assistant={assistant} categories={categories} />}
            </div>
          );
        })}
        {assistant.sending && (
          <div className="ai-msg ai-msg--assistant ai-msg--pending" role="status">
            {t('assistant.thinking')}
          </div>
        )}
      </div>

      {assistant.usage?.requests > 0 && (
        <p className="ai-panel__usage">
          {t('assistant.usage', { input: assistant.usage.inputTokens, output: assistant.usage.outputTokens })}
          {' · '}
          {typeof assistant.usage.costUsd === 'number' ? t('assistant.usageCost', { cost: assistant.usage.costUsd.toFixed(4) }) : t('assistant.usageNoCost')}
        </p>
      )}
      <form className="ai-panel__form" noValidate onSubmit={submit}>
        <label htmlFor={inputId} className="visually-hidden">
          {t('assistant.inputLabel')}
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
          className="field-input ai-panel__input"
          rows={2}
          value={draft}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder={t(ready ? 'assistant.placeholder' : 'assistant.placeholderOff')}
          disabled={!ready}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form.requestSubmit();
            }
          }}
        />
        <button
          type="button"
          className={`icon-btn ai-panel__mic${voice.state === 'recording' ? ' is-recording' : ''}`}
          aria-pressed={voice.state === 'recording'}
          aria-label={t(voice.state === 'recording' ? 'assistant.voice.stop' : 'assistant.voice.start')}
          title={t(voice.state === 'recording' ? 'assistant.voice.stop' : 'assistant.voice.start')}
          disabled={!ready || voice.state === 'transcribing'}
          onClick={() => {
            setVoiceNote(null);
            if (voice.state === 'idle' && !status?.speech?.available) {
              voice.clearError();
              setVoiceNote('NO_SPEECH_KEY');
              return;
            }
            voice.toggle();
          }}
        >
          <MicIcon size={18} />
        </button>
        <button type="submit" className="btn btn--primary btn--sm" disabled={!ready || assistant.sending || !draft.trim()}>
          {t('assistant.send')}
        </button>
      </form>
      {voice.state === 'recording' && (
        <p className="ai-panel__voice is-recording" role="status">
          {t('assistant.voice.recording', { time: `${Math.floor(voice.seconds / 60)}:${String(voice.seconds % 60).padStart(2, '0')}` })}
        </p>
      )}
      {voice.state === 'transcribing' && (
        <p className="ai-panel__voice" role="status">
          {t('assistant.voice.transcribing')}
        </p>
      )}
      {(voice.error || voiceNote) && voice.state === 'idle' && (
        <p className="ai-panel__voice is-error" role="alert">
          {t(voiceErrorKey(voice.error ?? voiceNote))}
        </p>
      )}
    </aside>
  );
}
