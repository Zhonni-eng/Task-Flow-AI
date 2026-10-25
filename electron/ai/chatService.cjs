// Assistant conversation for the current app session (main process). Provider-independent:
// it checks settings, builds the per-turn context, calls the stored key's provider adapter and
// keeps that provider's history in memory only (never written to disk). History is append-only:
// a turn is added only when it succeeded, and earlier turns are never edited or trimmed.
const { dateContext, buildUserTurn } = require('./prompt.cjs');
const { estimateCost, getProvider } = require('./providers.cjs');
const { selectTaskContext, taskSummary, tagSummary } = require('./taskContext.cjs');

const MAX_MESSAGE_LENGTH = 2000;
const MAX_TURNS = 20; // then the user starts a new conversation (no history trimming)
const MAX_CATEGORIES = 200;

function createChatService({
  settings,
  getCategories = () => [],
  getTasks = () => [],
  // App settings ({ availability }) for day plans.
  getAppSettings = () => ({}),
  now = () => new Date(),
  timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  adapterDeps = {},
  // Told the outcome of each request, so the connection status reflects real requests.
  onResult = () => {},
}) {
  const adapters = new Map();
  let history = [];
  let historyProvider = null;
  let turns = 0;
  // Task ids shown to the model in this conversation: the only ids its changes may target.
  let sharedIds = new Set();
  let busy = false;
  let epoch = 0; // bumped by reset(); a reply to an older conversation is discarded

  const adapterFor = (provider) => {
    if (!adapters.has(provider.id)) adapters.set(provider.id, provider.createAdapter(adapterDeps));
    return adapters.get(provider.id);
  };

  /** Only what task creation needs: category ids and names (no tasks, notes, paths or settings). */
  const categoryContext = () => {
    let list;
    try {
      list = getCategories();
    } catch {
      list = [];
    }
    return (Array.isArray(list) ? list : [])
      .filter((category) => category && typeof category.id === 'string' && typeof category.name === 'string')
      .slice(0, MAX_CATEGORIES)
      .map((category) => ({ id: category.id, name: category.name }));
  };

  function reset() {
    history = [];
    historyProvider = null;
    turns = 0;
    sharedIds = new Set();
    epoch += 1;
  }

  /**
   * `message`: the user's text (already type-checked by IPC); `language`: 'ru' | 'en';
   * `recentTaskIds`: tasks this assistant session created or changed (follow-up references). They
   * only choose which saved tasks are described; their data always comes from the saved tasks.
   * Returns { ok: true, plan: { reply, question, actions }, sharedTaskIds } or { ok: false, code }.
   */
  async function send(message, language, recentTaskIds = []) {
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text || text.length > MAX_MESSAGE_LENGTH) return { ok: false, code: 'INVALID_MESSAGE' };
    if (busy) return { ok: false, code: 'BUSY' };

    const state = settings.publicState();
    if (!state.enabled) return { ok: false, code: 'AI_DISABLED' };
    const target = settings.getTarget();
    const provider = getProvider(target.providerId);
    if (!provider?.createAdapter || !target.model) return { ok: false, code: 'PROVIDER_UNSUPPORTED' };
    const apiKey = state.key === 'stored' ? settings.getApiKey() : null;
    if (!apiKey) return { ok: false, code: 'NO_KEY' };

    // A conversation is never replayed to another service (or another compatible endpoint/model).
    const targetId = [provider.id, target.baseUrl ?? '', target.model].join('|');
    if (historyProvider && historyProvider !== targetId) reset();
    if (turns >= MAX_TURNS) return { ok: false, code: 'CONVERSATION_LIMIT' };

    let savedTasks;
    try {
      savedTasks = getTasks();
    } catch {
      savedTasks = [];
    }
    const date = dateContext(now(), timeZone());
    const categories = categoryContext();
    let appSettings;
    try {
      appSettings = getAppSettings() ?? {};
    } catch {
      appSettings = {};
    }
    // Tasks of this session first: changed by the assistant, then shown to it earlier in this
    // conversation - so "mark them as completed" after a question still has them in context.
    const pinned = [...new Set([...recentTaskIds, ...sharedIds])];
    const tasks = selectTaskContext(text, savedTasks, pinned, { categories, todayKey: date.today, nowTime: date.time });
    const userContent = buildUserTurn({
      message: text,
      language: language === 'en' ? 'en' : 'ru',
      categories,
      tasks,
      summary: taskSummary(Array.isArray(savedTasks) ? savedTasks : [], date.today, date.time),
      tags: tagSummary(savedTasks),
      availability: appSettings.availability ?? null,
      date,
    });

    busy = true;
    const startedIn = epoch;
    let result;
    try {
      result = await adapterFor(provider).proposePlan({ apiKey, model: target.model, baseUrl: target.baseUrl, history, userContent });
    } catch {
      result = { ok: false, code: 'PROVIDER_ERROR' };
    } finally {
      busy = false;
    }
    try {
      onResult(result);
    } catch {
      // Status bookkeeping must never break a reply.
    }
    if (startedIn !== epoch) return { ok: false, code: 'CANCELLED' };
    if (!result?.ok) return { ok: false, code: result?.code ?? 'PROVIDER_ERROR' };

    history = [...history, ...result.turn];
    historyProvider = targetId;
    turns += 1;
    sharedIds = new Set([...sharedIds, ...tasks.map((task) => task.id)]);
    const usage = result.usage ? { ...result.usage, model: target.model, costUsd: estimateCost(target.model, result.usage) } : null;
    return { ok: true, plan: result.plan, sharedTaskIds: [...sharedIds], usage };
  }

  return { send, reset, isBusy: () => busy, turnCount: () => turns };
}

module.exports = { createChatService, MAX_MESSAGE_LENGTH, MAX_TURNS };
