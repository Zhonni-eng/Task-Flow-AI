import { subtaskProgress } from '../data/subtasks.js';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { ChecklistIcon } from './Icons.jsx';

/** Compact "2/5" subtask indicator for cards and list rows; nothing for tasks without subtasks. */
export default function SubtaskProgress({ task }) {
  const { t } = useI18n();
  const progress = subtaskProgress(task);
  if (!progress) return null;
  const label = t('subtasks.progress', progress);
  const complete = progress.done === progress.total;
  return (
    <span className={`subtask-progress${complete ? ' is-complete' : ''}`} role="img" aria-label={label} title={label}>
      <ChecklistIcon size={13} />
      {progress.done}/{progress.total}
    </span>
  );
}
