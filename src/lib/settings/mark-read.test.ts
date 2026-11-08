import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
let nextSeq = 100;
vi.mock('$lib/reading-history/record', () => ({
  recordEvent: vi.fn((payload: Record<string, unknown>) =>
    Promise.resolve({ ...payload, device: 'dev-a', seq: ++nextSeq, t: Date.now() })
  ),
  onEventsRecorded: vi.fn(() => () => {})
}));

import { get } from 'svelte/store';
import { recordEvent } from '$lib/reading-history/record';
import {
  markVolumeUnread,
  markVolumesRead,
  registerCompletionListener,
  updateProgress,
  volumesWithTrash
} from './volume-data';

const recorded = vi.mocked(recordEvent);
const payloads = () => recorded.mock.calls.map((c) => c[0]);
const record = (id: string) => get(volumesWithTrash)[id];

beforeEach(() => {
  volumesWithTrash.set({});
  recorded.mockClear();
});

describe('markVolumesRead (#224)', () => {
  const credit = { pages: [139, 140], page_chars: [50, 70], time_ms: 60_000 };

  it('Count and Don’t count leave the same record and the same completion date', () => {
    updateProgress('a', 138, 9000);
    updateProgress('b', 138, 9000);
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 8, 12) });
    try {
      markVolumesRead([{ volume: 'a', pageCount: 140, totalChars: 9120, credit }]).release();
      markVolumesRead([{ volume: 'b', pageCount: 140, totalChars: 9120 }]).release();
    } finally {
      vi.useRealTimers();
    }
    const pick = (id: string) => {
      const r = record(id);
      return [r.progress, r.chars, r.completed, r.completedAt, r.lastProgressUpdate];
    };
    expect(pick('a')).toEqual(pick('b'));
    expect(record('a')).toMatchObject({ progress: 140, chars: 9120, completed: true });
    // Only the counted one has a credit beside the mark.
    const credits = payloads().filter((p) => p.kind === 'credit');
    expect(credits).toEqual([{ kind: 'credit', volume: 'a', ...credit }]);
  });

  it('Undo puts the pre-mark page back, retracts the credit, and the completion never goes out', async () => {
    updateProgress('a', 138, 9000);
    const heard: string[] = [];
    const stop = registerCompletionListener((id) => heard.push(id));
    try {
      const action = markVolumesRead([{ volume: 'a', pageCount: 140, credit }]);
      expect(record('a').completed).toBe(true);
      // Held while the Undo shows.
      expect(heard).toEqual([]);
      const [stored] = await action.credits;
      await action.undo();
      expect(record('a')).toMatchObject({ progress: 138, chars: 9000, completed: false });
      expect(payloads().at(-1)).toEqual({
        kind: 'retract',
        volume: 'a',
        target: [stored!.device, stored!.seq]
      });
      // The window closing after an Undo announces nothing.
      action.release();
      expect(heard).toEqual([]);
    } finally {
      stop();
    }
  });

  it('a mark the Undo was not used on is announced when the Undo goes', () => {
    const heard: string[] = [];
    const stop = registerCompletionListener((id) => heard.push(id));
    try {
      const action = markVolumesRead([
        { volume: 'a', pageCount: 10 },
        { volume: 'b', pageCount: 12 }
      ]);
      expect(heard).toEqual([]);
      action.release();
      expect(heard.sort()).toEqual(['a', 'b']);
    } finally {
      stop();
    }
  });

  it('a batch undoes as one', async () => {
    updateProgress('a', 3, 30);
    const action = markVolumesRead([
      { volume: 'a', pageCount: 10, credit },
      { volume: 'b', pageCount: 12, credit }
    ]);
    await action.undo();
    expect(record('a')).toMatchObject({ progress: 3, chars: 30, completed: false });
    expect(record('b')).toMatchObject({ progress: 0, completed: false });
    expect(payloads().filter((p) => p.kind === 'retract')).toHaveLength(2);
  });
});

describe('markVolumeUnread (#224)', () => {
  it('retracts the credits it is given; Undo restores the record and records the same credits again', async () => {
    markVolumesRead([{ volume: 'a', pageCount: 10 }]).release();
    const before = { ...record('a') };
    recorded.mockClear();
    const fields = { pages: [4, 5], page_chars: [10, 20], time_ms: 120_000 };
    const action = markVolumeUnread('a', [{ target: ['dev-z', 7], fields }]);
    expect(record('a')).toMatchObject({ progress: 0, completed: false, completedAt: undefined });
    expect(payloads().filter((p) => p.kind === 'retract')).toEqual([
      { kind: 'retract', volume: 'a', target: ['dev-z', 7] }
    ]);
    await action.undo();
    expect(record('a')).toMatchObject({
      progress: before.progress,
      completed: true,
      completedAt: before.completedAt
    });
    expect(payloads().at(-1)).toEqual({ kind: 'credit', volume: 'a', ...fields });
  });

  it('with no credit, retracts nothing', () => {
    markVolumesRead([{ volume: 'a', pageCount: 10 }]).release();
    recorded.mockClear();
    markVolumeUnread('a', []);
    expect(payloads().filter((p) => p.kind === 'retract')).toEqual([]);
  });
});
