import { useCallback, useEffect, useMemo, useState } from 'react';

const sameSet = (a, b) => a.size === b.size && [...a].every((id) => b.has(id));

/**
 * List View multi-selection by stable task id. Selection is UI state only (never saved).
 *
 * Rules that keep bulk actions predictable:
 * - The selection only ever contains tasks that are currently visible. When search,
 *   filters or edits hide a selected task, or a task is deleted, it is deselected.
 *   Sorting keeps the selection (the same tasks stay visible).
 * - Changing `contextKey` (sidebar destination or Board/List layout) clears the selection.
 */
export function useSelection(visibleIds, contextKey) {
  const [selected, setSelected] = useState(() => new Set());
  const visible = useMemo(() => new Set(visibleIds), [visibleIds]);

  useEffect(() => {
    setSelected((current) => (current.size === 0 ? current : new Set()));
  }, [contextKey]);

  useEffect(() => {
    setSelected((current) => {
      const kept = new Set([...current].filter((id) => visible.has(id)));
      return sameSet(kept, current) ? current : kept;
    });
  }, [visible]);

  // Never expose ids that are not visible, even before the pruning effect has run.
  const selectedIds = useMemo(() => visibleIds.filter((id) => selected.has(id)), [visibleIds, selected]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const toggle = useCallback((id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = visibleIds.length > 0 && selectedIds.length === visibleIds.length;

  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(visibleIds));
  }, [allSelected, visibleIds]);

  const clear = useCallback(() => setSelected(new Set()), []);

  return {
    selectedIds,
    isSelected: (id) => selectedSet.has(id),
    count: selectedIds.length,
    allSelected,
    someSelected: selectedIds.length > 0 && !allSelected,
    toggle,
    toggleAll,
    clear,
  };
}
