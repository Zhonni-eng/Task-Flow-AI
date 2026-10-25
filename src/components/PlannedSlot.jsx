import { useI18n } from '../i18n/I18nProvider.jsx';
import { parseDateKey } from '../utils/date.js';
import { ClockIcon } from './Icons.jsx';

/** An accepted day-plan slot ("Planned: 22 Oct, 10:00") - a plan, not a deadline. */
export default function PlannedSlot({ task }) {
  const { t, formatDate } = useI18n();
  const date = task.planned ? parseDateKey(task.planned.date) : null;
  if (!date || task.status === 'done') return null;
  const text = t('task.planned', { date: formatDate(date), time: task.planned.time });
  return (
    <span className="planned-slot" title={text}>
      <ClockIcon size={12} />
      <span>{text}</span>
    </span>
  );
}
