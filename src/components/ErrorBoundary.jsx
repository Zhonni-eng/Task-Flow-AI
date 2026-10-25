import { Component } from 'react';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { flushSaves } from '../storage/storage.js';
import { AlertIcon } from './Icons.jsx';

const reloadWindow = () => window.location.reload();

function ErrorFallback({ onReload }) {
  const { t } = useI18n();

  const reload = async () => {
    // Make sure every queued save reached the main process before reloading.
    try {
      await flushSaves();
    } finally {
      onReload();
    }
  };

  return (
    <div className="error-screen" role="alert">
      <AlertIcon size={32} className="error-screen__icon" />
      <h1 className="error-screen__title">{t('error.title')}</h1>
      <p className="error-screen__message">{t('error.message')}</p>
      <button type="button" className="btn btn--primary" onClick={reload} autoFocus>
        {t('error.reload')}
      </button>
    </div>
  );
}

/**
 * Catches unexpected rendering errors so the window never ends up blank. Task data is
 * not touched: everything already saved stays in the main-process data file.
 * `reload` defaults to reloading the window (overridable in tests).
 */
export default class ErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error('[Taskflow] Unexpected UI error', error, info?.componentStack);
  }

  render() {
    return this.state.failed ? <ErrorFallback onReload={this.props.reload ?? reloadWindow} /> : this.props.children;
  }
}
