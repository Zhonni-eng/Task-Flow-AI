import { useEffect, useId, useRef, useState } from 'react';
import { connectAi, disconnectAi, getAiSettings, saveAiSettings } from '../ai/aiSettingsClient.js';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { CloseIcon } from './Icons.jsx';
import VoiceKeySettings from './VoiceKeySettings.jsx';
import Modal from './Modal.jsx';

const KEY_MAX_LENGTH = 512;
// Error codes with their own reason text; anything else gets a generic one.
const CONNECT_ERRORS = [
  'INVALID_KEY', 'UNSUPPORTED_KEY', 'UNIDENTIFIED_KEY', 'AMBIGUOUS_KEY', 'NO_KEY', 'AUTH', 'PERMISSION', 'MODEL_UNAVAILABLE', 'RATE_LIMIT', 'TIMEOUT',
  'NETWORK', 'OVERLOADED', 'PROVIDER_ERROR', 'MALFORMED', 'BAD_REQUEST', 'INVALID_BASE_URL', 'INVALID_MODEL', 'ENDPOINT_NOT_FOUND',
  'SECURE_STORAGE_UNAVAILABLE', 'ENCRYPTION_FAILED', 'READ_ONLY', 'BUSY', 'UNAVAILABLE',
];
// Services that can be chosen in the advanced settings ('auto' = suggested by the key).
const SERVICES = ['auto', 'anthropic', 'openai', 'gemini', 'openai-compatible'];
// Errors that the advanced settings help with: they are opened to show the service choice.
const ADVANCED_ERRORS = ['UNIDENTIFIED_KEY', 'AMBIGUOUS_KEY', 'INVALID_BASE_URL', 'INVALID_MODEL', 'ENDPOINT_NOT_FOUND', 'MODEL_UNAVAILABLE'];
const SETTINGS_ERRORS = ['NOT_CONNECTED', 'READ_ONLY', 'UNAVAILABLE'];
// Connection states in which the stored key has passed a connection test.
const VERIFIED = ['connected', 'saved'];

/**
 * AI connection: an API key, Connect / Reconnect, the connection status, on/off and Disconnect.
 * The default view names no provider or model - the main process recognizes the key and tests it
 * before storing it. A collapsed advanced section lets the user choose the service explicitly
 * (for keys that cannot be recognized) or set up an OpenAI-compatible API (base URL + model).
 * The key is write-only: it is never shown or sent back to the page.
 */
export default function AiSettingsDialog({ onClose }) {
  const { t, formatDate } = useI18n();
  const [state, setState] = useState(null);
  // { context: 'connect' | 'settings', code, keptPrevious? }
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null); // null | 'connect' | 'settings'
  const [keyDraft, setKeyDraft] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [service, setService] = useState({ provider: 'auto', baseUrl: '', model: '' });
  const headingId = useId();
  const ids = { enabled: useId(), key: useId(), status: useId(), error: useId(), service: useId(), baseUrl: useId(), model: useId(), modelOverride: useId() };
  const keyInputRef = useRef(null);
  // The field appears only once the settings are loaded, and is disabled while a check runs, so it
  // is focused after that render (on opening, and again after a failed check).
  const refocusKey = useRef(false);

  useEffect(() => {
    if (busy || !state || !refocusKey.current) return;
    refocusKey.current = false;
    keyInputRef.current?.focus();
  }, [busy, state]);

  useEffect(() => {
    let cancelled = false;
    getAiSettings().then((result) => {
      if (cancelled) return;
      refocusKey.current = true;
      if (result.state) setState(result.state);
      // Prefill the OpenAI-compatible fields with the saved configuration (not secret).
      const compatible = result.state?.advanced?.compatible;
      if (compatible) setService((current) => ({ ...current, baseUrl: compatible.baseUrl, compatibleModel: compatible.model }));
      if (!result.ok) setError({ context: 'settings', code: result.code });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const keyStored = state?.key === 'stored';

  const connect = async (event) => {
    event.preventDefault();
    const key = keyDraft.trim() ? keyDraft : undefined;
    if (key === undefined && !keyStored) {
      setError({ context: 'connect', code: 'NO_KEY' });
      keyInputRef.current?.focus();
      return;
    }
    // The draft is cleared right away: the key is not kept in the page after it is sent.
    setKeyDraft('');
    setBusy('connect');
    setError(null);
    setNotice(null);
    const result = await connectAi(key, service.provider === 'openai-compatible' ? { ...service, model: service.compatibleModel } : service);
    if (result.state) setState(result.state);
    if (result.ok) {
      setNotice(key === undefined ? 'connectionChecked' : 'connectedNotice');
    } else {
      // A failed new key never replaces a working one: say that the previous key is still in use.
      const keptPrevious = key !== undefined && keyStored && result.state?.key === 'stored';
      setError({ context: 'connect', code: result.code, keptPrevious });
      if (ADVANCED_ERRORS.includes(result.code)) setAdvancedOpen(true);
      refocusKey.current = true;
    }
    setBusy(null);
  };

  const runSetting = async (action, successNotice) => {
    setBusy('settings');
    setError(null);
    setNotice(null);
    const result = await action();
    setBusy(null);
    if (result.state) setState(result.state);
    if (result.ok) setNotice(successNotice ?? null);
    else setError({ context: 'settings', code: result.code });
  };

  const secureUnavailable = state?.secureStorage === 'unavailable';
  const readOnly = state ? !state.writable : true;
  const connection = busy === 'connect' ? 'testing' : state?.connection;
  const verified = VERIFIED.includes(state?.connection);
  const verifiedAt = state?.verifiedAt ? new Date(state.verifiedAt) : null;
  const verifiedText =
    verifiedAt && !Number.isNaN(verifiedAt.getTime())
      ? formatDate(verifiedAt, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
      : null;

  const errorText = () => {
    if (!error) return null;
    if (error.context === 'settings') return t(`ai.errors.${SETTINGS_ERRORS.includes(error.code) ? error.code : 'generic'}`);
    const reason = t(`ai.connectErrors.${CONNECT_ERRORS.includes(error.code) ? error.code : 'generic'}`);
    // "Connection failed" heads every outcome except "nothing to connect with" and "already checking".
    const failed = !['NO_KEY', 'BUSY'].includes(error.code);
    return [failed ? t('ai.connectFailed') : null, reason, error.keptPrevious ? t('ai.previousKeyKept') : null].filter(Boolean).join(' ');
  };

  return (
    <Modal onClose={onClose} labelledBy={headingId} size="sm">
      <header className="modal__header">
        <h2 id={headingId} className="modal__title">
          {t('ai.settingsTitle')}
        </h2>
        <button type="button" className="icon-btn" aria-label={t('actions.close')} title={t('actions.close')} onClick={onClose}>
          <CloseIcon size={18} />
        </button>
      </header>

      <div className="modal__body ai-settings" aria-busy={Boolean(busy) || !state}>
        <p className="ai-settings__intro">{t('ai.intro')}</p>
        {!state && !error && <p className="ai-settings__hint">{t('ai.loading')}</p>}

        {state && (
          <>
            {readOnly && (
              <p className="ai-settings__warning" role="status">
                {t(state.status === 'newer-version' ? 'ai.readOnlyNewer' : 'ai.readOnly')}
              </p>
            )}

            <div id={ids.status} className={`ai-settings__status is-${connection}`} role="status">
              <span className="ai-settings__status-dot" aria-hidden="true" />
              <div>
                <p className="ai-settings__status-title">{t(`ai.connection.${connection}`)}</p>
                {connection === 'saved' && verifiedText && <p className="ai-settings__hint">{t('ai.connectionHint.savedAt', { date: verifiedText })}</p>}
                {connection !== 'testing' && <p className="ai-settings__hint">{t(`ai.connectionHint.${connection}`)}</p>}
              </div>
            </div>

            <form className="field" noValidate onSubmit={connect}>
              <label className="field-label" htmlFor={ids.key}>
                {t('ai.apiKey')}
              </label>
              {secureUnavailable ? (
                <p className="ai-settings__warning" role="status">
                  {t('ai.secureStorageUnavailable')}
                </p>
              ) : (
                <div className="ai-settings__key-row">
                  <input
                    id={ids.key}
                    ref={keyInputRef}
                    type="password"
                    data-autofocus
                    className={`field-input${error?.context === 'connect' && ['INVALID_KEY', 'UNSUPPORTED_KEY', 'AMBIGUOUS_KEY', 'NO_KEY', 'AUTH'].includes(error.code) ? ' has-error' : ''}`}
                    value={keyDraft}
                    maxLength={KEY_MAX_LENGTH}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t(keyStored ? 'ai.keyReplacePlaceholder' : 'ai.keyPlaceholder')}
                    disabled={Boolean(busy) || readOnly}
                    aria-invalid={error?.context === 'connect' ? true : undefined}
                    aria-describedby={[ids.status, error ? ids.error : null].filter(Boolean).join(' ')}
                    onChange={(event) => {
                      setKeyDraft(event.target.value);
                      if (error?.context === 'connect') setError(null);
                    }}
                  />
                  <button type="submit" className="btn btn--primary" disabled={Boolean(busy) || readOnly}>
                    {busy === 'connect' ? t('ai.connecting') : t(keyStored ? 'ai.reconnect' : 'ai.connect')}
                  </button>
                </div>
              )}
              {/* Connection errors stay next to the field, so they are visible without scrolling. */}
              {error?.context === 'connect' && (
                <p id={ids.error} className="field-error" role="alert">
                  {errorText()}
                </p>
              )}
              {keyStored && !secureUnavailable && <p className="ai-settings__hint">{t('ai.reconnectHint')}</p>}

              {!secureUnavailable && (
                <details className="ai-settings__advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
                  <summary>{t('ai.advanced.title')}</summary>
                  <div className="ai-settings__advanced-body">
                    {state.advanced?.provider && (
                      <p className="ai-settings__hint">
                        {t('ai.advanced.current', {
                          service:
                            t(`ai.services.${state.advanced.provider}`) +
                            (state.advanced.provider === 'openai-compatible' && state.advanced.compatible
                              ? ` (${state.advanced.compatible.baseUrl}, ${state.advanced.compatible.model})`
                              : state.advanced.model
                                ? ` (${state.advanced.model})`
                                : ''),
                        })}
                      </p>
                    )}
                    <div className="field">
                      <label className="field-label" htmlFor={ids.service}>
                        {t('ai.advanced.service')}
                      </label>
                      <select
                        id={ids.service}
                        className="field-input"
                        value={service.provider}
                        disabled={Boolean(busy) || readOnly}
                        onChange={(event) => setService((current) => ({ ...current, provider: event.target.value }))}
                      >
                        {SERVICES.map((id) => (
                          <option key={id} value={id}>
                            {t(`ai.services.${id}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                    {service.provider === 'openai-compatible' && (
                      <>
                        <div className="field">
                          <label className="field-label" htmlFor={ids.baseUrl}>
                            {t('ai.advanced.baseUrl')}
                          </label>
                          <input
                            id={ids.baseUrl}
                            type="url"
                            className={`field-input${error?.code === 'INVALID_BASE_URL' || error?.code === 'ENDPOINT_NOT_FOUND' ? ' has-error' : ''}`}
                            value={service.baseUrl}
                            maxLength={300}
                            spellCheck={false}
                            autoComplete="off"
                            placeholder="https://example.com/v1"
                            disabled={Boolean(busy) || readOnly}
                            onChange={(event) => setService((current) => ({ ...current, baseUrl: event.target.value }))}
                          />
                        </div>
                        <div className="field">
                          <label className="field-label" htmlFor={ids.model}>
                            {t('ai.advanced.model')}
                          </label>
                          <input
                            id={ids.model}
                            type="text"
                            className={`field-input${error?.code === 'INVALID_MODEL' || error?.code === 'MODEL_UNAVAILABLE' ? ' has-error' : ''}`}
                            value={service.compatibleModel ?? ''}
                            maxLength={200}
                            spellCheck={false}
                            autoComplete="off"
                            disabled={Boolean(busy) || readOnly}
                            onChange={(event) => setService((current) => ({ ...current, compatibleModel: event.target.value }))}
                          />
                        </div>
                        <p className="ai-settings__hint">{t('ai.advanced.compatibleHint')}</p>
                      </>
                    )}
                    {service.provider !== 'openai-compatible' && (
                      <div className="field">
                        <label className="field-label" htmlFor={ids.modelOverride}>
                          {t('ai.advanced.modelOptional')}
                        </label>
                        <input
                          id={ids.modelOverride}
                          type="text"
                          className={`field-input${error?.code === 'INVALID_MODEL' || error?.code === 'MODEL_UNAVAILABLE' ? ' has-error' : ''}`}
                          value={service.model}
                          maxLength={200}
                          spellCheck={false}
                          autoComplete="off"
                          placeholder={t('ai.advanced.modelPlaceholder')}
                          disabled={Boolean(busy) || readOnly}
                          onChange={(event) => setService((current) => ({ ...current, model: event.target.value }))}
                        />
                        <p className="ai-settings__hint">{t('ai.advanced.modelHint')}</p>
                      </div>
                    )}
                    <p className="ai-settings__hint">{t('ai.advanced.detectionHint')}</p>
                  </div>
                </details>
              )}
            </form>

            {/* On/off needs a verified connection; while it is on, it can always be switched off. */}
            {(verified || state.enabled) && (
              <div className="field ai-settings__toggle">
                <label className="ai-settings__switch" htmlFor={ids.enabled}>
                  <input
                    id={ids.enabled}
                    type="checkbox"
                    checked={state.enabled}
                    disabled={Boolean(busy) || readOnly || (!verified && !state.enabled)}
                    onChange={(event) => runSetting(() => saveAiSettings({ enabled: event.target.checked }))}
                  />
                  <span>{t('ai.enable')}</span>
                </label>
              </div>
            )}

            {state.key !== 'none' && (
              <button
                type="button"
                className="btn btn--sm btn--ghost ai-settings__remove"
                disabled={Boolean(busy) || readOnly}
                onClick={() => runSetting(() => disconnectAi(), 'disconnectedNotice')}
              >
                {t('ai.disconnect')}
              </button>
            )}

            <VoiceKeySettings state={state} onState={setState} disabled={Boolean(busy) || readOnly || secureUnavailable} />

            <p className="ai-settings__hint">{t('ai.privacyNote')}</p>
          </>
        )}

        {error && (error.context !== 'connect' || !state) && (
          <p id={ids.error} className="field-error" role="alert">
            {errorText()}
          </p>
        )}
        {notice && (
          <p className="ai-settings__notice" role="status">
            {t(`ai.${notice}`)}
          </p>
        )}
      </div>

      <footer className="modal__footer">
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          {t('ai.done')}
        </button>
      </footer>
    </Modal>
  );
}
