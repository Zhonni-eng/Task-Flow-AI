import { dueState } from '../data/dueDates.js';
import { recurrenceLabel, reminderLabel } from '../data/scheduleText.js';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { parseDateKey } from '../utils/date.js';
import { AlertIcon, BellIcon, CalendarIcon, ClockIcon, RepeatIcon } from './Icons.jsx';

const ICONS = { overdue: AlertIcon, today: ClockIcon };

/**
 * Due date of a task with its state. Overdue and due-today dates differ by icon and
 * wording, not only by color; completed tasks are never shown as overdue.
 * `variant`: 'card' (short date, Board) or 'list' (date with year, List View).
 */
export default function DueDate({ task, variant = 'card' }) {
  const { t, formatDate } = useI18n();
  const due = parseDateKey(task.dueDate);
  if (!due) return variant === 'list' ? <span className="task-list__muted">—</span> : null;

  const state = dueState(task);
  const date = formatDate(due, variant === 'list' ? { day: 'numeric', month: 'short', year: 'numeric' } : undefined);
  // The due time belongs to the deadline: "30 Oct, 16:30", "Today, 16:30".
  const withTime = (text) => (task.dueTime ? t('task.dateTime', { date: text, time: task.dueTime }) : text);
  const formatted = withTime(date);
  const text = {
    overdue: variant === 'list' ? formatted : `${t('task.overdue')} · ${formatted}`,
    today: withTime(t('task.dueToday')),
    tomorrow: withTime(t('task.dueTomorrow')),
  }[state] ?? formatted;
  const repeats = task.recurrence ? t('task.repeats', { rule: recurrenceLabel(t, task.recurrence) }) : null;
  const reminders = task.reminders?.length
    ? t('task.hasReminders', { list: task.reminders.map((offset) => reminderLabel(t, offset, Boolean(task.dueTime)).toLocaleLowerCase()).join(', ') })
    : null;
  const description = {
    overdue: t('task.dueOverdue', { date: formatted }),
    today: t('task.dueTodayFull', { date: formatted }),
    tomorrow: t('task.dueTomorrowFull', { date: formatted }),
  }[state] ?? t('task.due', { date: formatted });
  const Icon = ICONS[state] ?? CalendarIcon;
  // Earlier class names stay as hooks for styling and the Electron checks.
  const hook = variant === 'card' ? ' task-card__due' : state === 'overdue' ? ' task-list__overdue' : '';

  const iconSize = variant === 'list' ? 13 : 14;
  return (
    <span className={`due due--${variant} is-${state}${hook}`} title={[description, repeats, reminders].filter(Boolean).join('\n')} data-due-state={state}>
      <Icon size={iconSize} />
      <time dateTime={task.dueTime ? `${task.dueDate}T${task.dueTime}` : task.dueDate} aria-hidden="true">
        {text}
      </time>
      {repeats && <RepeatIcon size={iconSize} className="due__marker" />}
      {reminders && <BellIcon size={iconSize} className="due__marker" />}
      <span className="visually-hidden">{[description, repeats, reminders].filter(Boolean).join('. ')}</span>
    </span>
  );
}
