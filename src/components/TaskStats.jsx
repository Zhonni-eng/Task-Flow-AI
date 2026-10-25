import { useI18n } from '../i18n/I18nProvider.jsx';

// Compact summary of the whole task collection (not just the filtered view).
export default function TaskStats({ stats }) {
  const { t } = useI18n();
  const empty = stats.total === 0;

  return (
    <section className="stats" aria-label={t('stats.label')}>
      <div className="stats__item">
        <span className="stats__value">{stats.total}</span>
        <span className="stats__name">{t('stats.total')}</span>
      </div>
      <div className="stats__item">
        <span className="stats__value stats__value--done">{stats.done}</span>
        <span className="stats__name">{t('stats.done')}</span>
      </div>
      <div className="stats__item">
        <span className={`stats__value${stats.overdue > 0 ? ' stats__value--overdue' : ''}`}>{stats.overdue}</span>
        <span className="stats__name">{t('stats.overdue')}</span>
      </div>
      <div
        className="stats__progress"
        role="progressbar"
        aria-label={t('stats.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={empty ? undefined : stats.percent}
        aria-valuetext={empty ? t('stats.noTasks') : t('stats.percent', { percent: stats.percent })}
        title={empty ? t('stats.noTasks') : t('stats.progressTitle', { done: stats.done, total: stats.total })}
      >
        <span className="stats__bar">
          <span className="stats__bar-fill" style={{ width: `${empty ? 0 : stats.percent}%` }} />
        </span>
        <span className="stats__percent">{empty ? '—' : t('stats.percent', { percent: stats.percent })}</span>
      </div>
    </section>
  );
}
