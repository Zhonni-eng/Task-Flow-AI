// Renderer access to the assistant through the restricted preload API. Requests are made by the
// main process; this side only sends the user's text and receives a proposal to validate.
// Every call resolves to { ok, ... } / { ok: false, code } and never throws.

const bridge = () => (typeof window !== 'undefined' ? window.taskflow?.ai : undefined);

/** `recentTaskIds`: tasks this session created or changed, so follow-ups ("move it") can be resolved. */
export async function sendChat(message, language, recentTaskIds = []) {
  const api = bridge();
  if (!api?.chat) return { ok: false, code: 'UNAVAILABLE' };
  try {
    const result = await api.chat({ message, language, recentTaskIds });
    return result && typeof result.ok === 'boolean' ? result : { ok: false, code: 'NO_RESULT' };
  } catch {
    return { ok: false, code: 'IPC_FAILED' };
  }
}

export async function resetChat() {
  try {
    await bridge()?.resetChat?.();
  } catch {
    // Nothing to recover: the next message simply starts a new conversation.
  }
}
