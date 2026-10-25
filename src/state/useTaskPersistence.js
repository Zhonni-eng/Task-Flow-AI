import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getSaveStatus, saveBoard, subscribeSaveStatus } from '../storage/storage.js';

/**
 * Saves the task list whenever it changes. Cleanly loaded data is not written back
 * on startup; first-launch sample tasks and recovered, repaired or migrated data are
 * saved immediately (sample tasks are then never re-created).
 */
export function useTaskPersistence(tasks, categories, boot) {
  const skipInitial = useRef(boot.status === 'loaded');

  useEffect(() => {
    if (skipInitial.current) {
      skipInitial.current = false;
      return;
    }
    // Tasks and categories are written together so assignments stay consistent.
    saveBoard({ tasks, categories });
  }, [tasks, categories]);

  return useSyncExternalStore(subscribeSaveStatus, getSaveStatus);
}
