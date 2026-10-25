// Serializes saves: at most one write in flight, and only the latest snapshot is
// written next. Rapid changes coalesce, and an older snapshot can never land after
// a newer one.
export function createSaveQueue(write, onResult) {
  let latest;
  let hasPending = false;
  let running = null;

  async function drain() {
    while (hasPending) {
      hasPending = false;
      const snapshot = latest;
      let result;
      try {
        result = await write(snapshot);
      } catch {
        result = { ok: false, code: 'IPC_FAILED' };
      }
      onResult(result ?? { ok: false, code: 'NO_RESULT' });
    }
    running = null;
  }

  return {
    save(snapshot) {
      latest = snapshot;
      hasPending = true;
      if (!running) running = drain();
      return running;
    },
    /** Re-sends the most recent snapshot (after a failure). */
    retry() {
      if (latest === undefined) return Promise.resolve();
      return this.save(latest);
    },
    /** Resolves once everything queued so far has been written (or failed). */
    flush() {
      return running ?? Promise.resolve();
    },
  };
}
