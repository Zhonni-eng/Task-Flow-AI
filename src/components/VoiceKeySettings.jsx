import { useId, useState } from 'react';
import { connectSpeechKey } from '../ai/aiSettingsClient.js';
import { useI18n } from '../i18n/I18nProvider.jsx';

const KNOWN = ['INVALID_KEY', 'AUTH', 'PERMISSION', 'MODEL_UNAVAILABLE', 'RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'OVERLOADED', 'SECURE_STORAGE_UNAVAILABLE', 'READ_ONLY'];

/**
 * Voice input (AI settings): uses the stored OpenAI key - the assistant's when it uses OpenAI. Without
 * one, an OpenAI key can be saved for voice input only: it is checked first, stored encrypted, and
 * does not change the assistant's service. The key is never shown again.
 */
export default function VoiceKeySettings({ state, onState, disabled }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { ok, code }
  const ids = { heading: useId(), key: useId() };
  const available = Boolean(state.speech?.available);
  const usesChatKey = state.advanced?.provider === 'openai';

  const save = async (event) => {
    event.preventDefault();
    const key = draft;
    setDraft('');
    if (!key.trim()) return;
    setBusy(true);
    setMessage(null);
    const result = await connectSpeechKey(key);
    setBusy(false);
    if (result.state) onState(result.state);
    setMessage(result.ok ? { ok: true } : { ok: false, code: result.code });
  };

  return (
    <section className="field ai-settings__voice" aria-labelledby={ids.heading}>
      <h3 id={ids.heading} className="field-label">
        {t('ai.voice.title')}
      </h3>
      <p className="ai-settings__hint">{t(available ? (usesChatKey ? 'ai.voice.usesChatKey' : 'ai.voice.ready') : 'ai.voice.needsKey')}</p>
      {!usesChatKey && (
        <form className="ai-settings__key-row" noValidate onSubmit={save}>
          <input
            id={ids.key}
            type="password"
            className="field-input"
            aria-label={t('ai.voice.keyLabel')}
            placeholder={t(available ? 'ai.voice.replacePlaceholder' : 'ai.voice.keyPlaceholder')}
            value={draft}
            maxLength={512}
            autoComplete="off"
            spellCheck={false}
            disabled={busy || disabled}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="btn btn--ghost" disabled={busy || disabled || !draft.trim()}>
            {busy ? t('ai.connecting') : t('ai.voice.save')}
          </button>
        </form>
      )}
      {message && (
        <p className={message.ok ? 'ai-settings__notice' : 'field-error'} role={message.ok ? 'status' : 'alert'}>
          {message.ok ? t('ai.voice.saved') : `${t('ai.connectFailed')} ${t(`ai.connectErrors.${KNOWN.includes(message.code) ? message.code : 'generic'}`)}`}
        </p>
      )}
      <p className="ai-settings__hint">{t('ai.voice.privacy')}</p>
    </section>
  );
}
