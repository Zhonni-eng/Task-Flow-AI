import { describe, expect, it } from 'vitest';
import { createSaveQueue } from '../../src/storage/saveQueue.js';

/** A write function whose calls resolve only when the test says so. */
function controlledWriter() {
  const calls = [];
  const write = (snapshot) =>
    new Promise((resolve) => {
      calls.push({ snapshot, resolve });
    });
  return { write, calls };
}

describe('createSaveQueue', () => {
  it('runs one write at a time and writes only the latest snapshot next', async () => {
    const { write, calls } = controlledWriter();
    const results = [];
    const queue = createSaveQueue(write, (result) => results.push(result));

    queue.save('v1');
    queue.save('v2');
    queue.save('v3');
    expect(calls.map((call) => call.snapshot)).toEqual(['v1']);

    calls[0].resolve({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.map((call) => call.snapshot)).toEqual(['v1', 'v3']);

    calls[1].resolve({ ok: true });
    await queue.flush();
    expect(results).toEqual([{ ok: true }, { ok: true }]);
  });

  it('reports thrown errors as failed results and keeps working', async () => {
    const results = [];
    let fail = true;
    const queue = createSaveQueue(async () => {
      if (fail) throw new Error('ipc down');
      return { ok: true };
    }, (result) => results.push(result));

    await queue.save('a');
    expect(results).toEqual([{ ok: false, code: 'IPC_FAILED' }]);
    fail = false;
    await queue.retry();
    expect(results.at(-1)).toEqual({ ok: true });
  });

  it('retry re-sends the latest snapshot and flush resolves when idle', async () => {
    const written = [];
    const queue = createSaveQueue(async (snapshot) => {
      written.push(snapshot);
      return { ok: true };
    }, () => {});
    await queue.flush();
    await queue.retry();
    expect(written).toEqual([]);
    await queue.save({ n: 1 });
    await queue.retry();
    expect(written).toEqual([{ n: 1 }, { n: 1 }]);
  });
});
