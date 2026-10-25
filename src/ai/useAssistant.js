// Assistant session state in the renderer: messages, proposals, applying and undo.
// Proposals from the provider are untrusted: they are validated against the current tasks when
// they arrive and again, for the selected items only, immediately before anything changes (a bulk
// change must still match exactly the tasks the user reviewed). Changes are applied as one batch
// through the normal reducer and save flow; success is reported only after that save succeeded.
import { useCallback, useEffect, useRef, useState } from 'react';
import { categoryActions } from '../state/categoriesReducer.js';
import { taskActions } from '../state/tasksReducer.js';
import { waitForNextBoardSave } from '../storage/storage.js';
import { validateActionPlan } from './actionPlan.js';
import { applyPlan, planUndo } from './applyPlan.js';
import { resetChat, sendChat } from './chatClient.js';

const APPLICABLE = new Set(['create', 'update', 'delete', 'addSubtask', 'updateSubtask', 'deleteSubtask', 'moveSubtask', 'bulk', 'schedule', 'renameLabel', 'deleteLabel']);
// Actions whose tasks the app resolves itself; they must still match the same tasks when applied.
const RESOLVED = ['bulk', 'renameLabel', 'deleteLabel'];
const BLOCKING_WARNINGS = ['possibleDuplicate', 'duplicateInPlan', 'noChange', 'conflictsWithEarlier'];
const MAX_RECENT_IDS = 50;

let nextId = 1;
const messageId = () => `ai-msg-${nextId++}`;
const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * Review items. Unticked by default: invalid or unsupported items, likely duplicates, changes that
 * change nothing, and every action touching a task an earlier action already changes. Bulk
 * changes that match no task cannot be selected.
 */
/** Every task an entry would change (for spotting several actions on one task). */
function touchedIds(entry) {
  const n = entry.normalized ?? entry;
  if (RESOLVED.includes(entry.type)) return entry.matches ?? [];
  if (entry.type === 'schedule') return (n.items ?? []).map((item) => item.taskId);
  return [n.taskId ?? entry.target?.id, n.toTaskId].filter(Boolean);
}

function buildProposal(plan, validation) {
  const entries = validation.actions.filter((entry) => entry.type !== 'none');
  // A task that more than one action wants to change: none of those actions is preselected.
  const counts = new Map();
  for (const entry of entries) for (const id of new Set(touchedIds(entry))) counts.set(id, (counts.get(id) ?? 0) + 1);
  const items = entries.map((entry) => {
    const supported = APPLICABLE.has(entry.type);
    const selectable = supported && entry.valid && !entry.warnings.includes('noMatches');
    const conflict = touchedIds(entry).some((id) => counts.get(id) > 1);
    const blocked = conflict || entry.warnings.some((warning) => BLOCKING_WARNINGS.includes(warning));
    return {
      index: entry.index,
      raw: plan.actions[entry.index],
      entry,
      conflict,
      supported,
      selectable,
      selected: selectable && !blocked,
    };
  });
  return items.length > 0 ? { items, status: 'pending', result: null } : null;
}

/** Adds one request's usage to a running total (only figures the provider reported). */
function addUsage(total, usage) {
  if (!usage) return total;
  return {
    requests: total.requests + 1,
    inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
    // A cost is shown only while every request had a known price.
    costUsd: typeof total.costUsd === 'number' && typeof usage.costUsd === 'number' ? total.costUsd + usage.costUsd : null,
  };
}
const EMPTY_USAGE = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

export function useAssistant({ tasks, categories, dispatch, dispatchCategory = () => {}, language, availability = null }) {
  const [messages, setMessages] = useState([]);
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [usage, setUsage] = useState(EMPTY_USAGE);
  // Last confirmed batch: { messageId, undo } (see applyPlan.js)
  const [undoBatch, setUndoBatch] = useState(null);
  const latest = useRef({ tasks, categories, availability });
  const busyRef = useRef(false);
  const recentIds = useRef([]); // tasks this session created or changed (follow-up references)
  const sharedIds = useRef([]); // tasks the provider has been shown in this conversation

  useEffect(() => {
    latest.current = { tasks, categories, availability };
  }, [tasks, categories, availability]);

  const update = useCallback((id, change) => {
    setMessages((list) => list.map((message) => (message.id === id ? { ...message, ...change(message) } : message)));
  }, []);
  const remember = (ids) => {
    recentIds.current = [...new Set([...ids, ...recentIds.current])].slice(0, MAX_RECENT_IDS);
  };
  const validationContext = () => ({ ...latest.current, allowedTaskIds: sharedIds.current, now: new Date() });

  const send = useCallback(
    async (text) => {
      const message = text.trim();
      if (!message || busyRef.current) return false;
      busyRef.current = true;
      setSending(true);
      setMessages((list) => [...list, { id: messageId(), role: 'user', text: message }]);
      const recentTaskIds = recentIds.current.filter((id) => latest.current.tasks.some((task) => task.id === id));
      const result = await sendChat(message, language, recentTaskIds);
      busyRef.current = false;
      setSending(false);
      if (result.usage) setUsage((total) => addUsage(total, result.usage));
      if (!result.ok) {
        setMessages((list) => [...list, { id: messageId(), role: 'error', code: result.code }]);
        return true;
      }
      sharedIds.current = Array.isArray(result.sharedTaskIds) ? result.sharedTaskIds.filter((id) => typeof id === 'string') : [];
      const validation = validateActionPlan(result.plan, validationContext());
      if (validation.errors.length > 0) {
        setMessages((list) => [...list, { id: messageId(), role: 'error', code: 'MALFORMED' }]);
        return true;
      }
      setMessages((list) => [
        ...list,
        { id: messageId(), role: 'assistant', reply: validation.reply, question: validation.question, proposal: buildProposal(result.plan, validation) },
      ]);
      return true;
    },
    [language],
  );

  const toggle = useCallback(
    (id, index) => {
      update(id, (message) => ({
        proposal: {
          ...message.proposal,
          result: null,
          items: message.proposal.items.map((item) => (item.index === index && item.selectable ? { ...item, selected: !item.selected } : item)),
        },
      }));
    },
    [update],
  );

  const dismiss = useCallback((id) => update(id, (message) => ({ proposal: { ...message.proposal, status: 'dismissed' } })), [update]);

  /** Applies the selected items of one proposal after re-checking them against current data. */
  const apply = useCallback(
    async (id) => {
      if (busyRef.current) return;
      const message = messages.find((item) => item.id === id);
      const proposal = message?.proposal;
      if (!proposal || proposal.status !== 'pending') return;
      const chosen = proposal.items.filter((item) => item.selected && item.selectable);
      if (chosen.length === 0) return;

      const recheck = validateActionPlan({ actions: chosen.map((item) => item.raw) }, validationContext());
      const stillSame = recheck.actions.every((entry, i) => !RESOLVED.includes(entry.type) || sameList(entry.matches ?? [], chosen[i].entry.matches ?? []));
      if (!recheck.ok || !stillSame || recheck.actions.some((entry) => !APPLICABLE.has(entry.type) || entry.warnings.includes('noMatches'))) {
        update(id, (current) => ({ proposal: { ...current.proposal, result: { kind: 'changed' } } }));
        return;
      }
      if (recheck.actions.some((entry) => entry.warnings.includes('conflictsWithEarlier'))) {
        update(id, (current) => ({ proposal: { ...current.proposal, result: { kind: 'conflict' } } }));
        return;
      }

      busyRef.current = true;
      setApplying(true);
      const outcome = applyPlan({ tasks: latest.current.tasks, categories: latest.current.categories, entries: recheck.actions, now: new Date() });
      const anything = outcome.tasks.length + outcome.removeIds.length > 0;
      const saved = waitForNextBoardSave();
      if (outcome.categories.length > 0) dispatchCategory(categoryActions.add(outcome.categories));
      if (anything) dispatch(taskActions.replace(outcome.tasks, outcome.removeIds));
      const save = anything || outcome.categories.length > 0 ? await saved : { ok: true };
      busyRef.current = false;
      setApplying(false);

      remember(outcome.tasks.map((task) => task.id));
      update(id, (msg) => ({
        proposal: { ...msg.proposal, status: 'applied', result: { kind: 'applied', ...outcome.counts, categories: outcome.categories.length, saved: save.ok } },
      }));
      setUndoBatch({ messageId: id, undo: outcome.undo });
    },
    [messages, dispatch, dispatchCategory, update],
  );

  /**
   * Reverts the last confirmed batch - but only what is still exactly as the assistant left it.
   * Deleted tasks come back; tasks edited since are kept; categories it created are removed when
   * no task uses them any more.
   */
  const undo = useCallback(async () => {
    if (!undoBatch || busyRef.current) return;
    const result = planUndo(undoBatch.undo, latest.current.tasks);
    const remaining = new Map(latest.current.tasks.map((task) => [task.id, task]));
    for (const id of result.removeIds) remaining.delete(id);
    for (const task of result.tasks) remaining.set(task.id, task);
    const unusedCategories = undoBatch.undo.categoryIds.filter((categoryId) => ![...remaining.values()].some((task) => task.categoryId === categoryId));

    busyRef.current = true;
    setApplying(true);
    let outcome = { ok: true };
    if (result.tasks.length + result.removeIds.length + unusedCategories.length > 0) {
      const saved = waitForNextBoardSave();
      if (result.tasks.length + result.removeIds.length > 0) dispatch(taskActions.replace(result.tasks, result.removeIds));
      if (unusedCategories.length > 0) dispatchCategory(categoryActions.removeMany(unusedCategories));
      outcome = await saved;
    }
    busyRef.current = false;
    setApplying(false);
    update(undoBatch.messageId, (msg) => ({
      proposal: { ...msg.proposal, status: 'undone', result: { kind: 'undone', removed: result.removed, restored: result.restored, kept: result.kept, saved: outcome.ok } },
    }));
    setUndoBatch(null);
  }, [undoBatch, dispatch, dispatchCategory, update]);

  const reset = useCallback(async () => {
    if (busyRef.current) return;
    setMessages([]);
    setUndoBatch(null);
    recentIds.current = [];
    sharedIds.current = [];
    await resetChat();
  }, []);

  return { messages, sending, applying, undoBatch, usage, send, toggle, apply, dismiss, undo, reset };
}
