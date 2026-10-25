import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { I18nProvider } from './i18n/I18nProvider.jsx';
import { saveLanguage } from './storage/storage.js';

// The provider tree around the app, shared by main.jsx and the component tests.
export default function AppRoot({ boot }) {
  return (
    <I18nProvider initialLanguage={boot.language} onLanguageChange={saveLanguage}>
      <ErrorBoundary>
        <App boot={boot} />
      </ErrorBoundary>
    </I18nProvider>
  );
}
