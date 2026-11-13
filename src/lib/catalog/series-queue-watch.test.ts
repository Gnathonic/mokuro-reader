/**
 * The watch schedule (queue file v2 §8.7), on its own: when a watched
 * series is read, what ends a watch, and what never gets read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchEntry } from './server-ocr-queue';
import {
  WATCH_BACKOFF_MS,
  WATCH_MAX_WAIT_MS,
  WATCH_ROTATION,
  WatchSchedule,
  watchGroupId,
  type WatchGroup,
  type WatchLook
} from './series-queue-watch';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const W = 120_000;

function watch(series: string, volume: string, addedAt = NOW): WatchEntry {
  return {
    key: `${series.toLowerCase()}\u0000${volume.toLowerCase()}`,
    volume_uuid: `${series}/${volume}`,
    series,
    volume,
    queue_url: 'cloud:google-drive',
    manifest_url: '',
    auth: 'cloud',
    source: 'google-drive',
    added_at: addedAt
  };
}

function read(
  present: Record<string, number | null> = {},
  done: string[] = [],
  windowMs = W
): WatchLook {
  return { kind: 'read', windowMs, present: new Map(Object.entries(present)), done: new Set(done) };
}

function rig(initial: WatchEntry[]) {
  const watches = new Map(initial.map((w) => [w.key, w]));
  let hidden = false;
  const looks: string[] = [];
  let answer: (group: WatchGroup) => WatchLook | Promise<WatchLook> = () => read();
  const look = vi.fn(async (group: WatchGroup) => {
    looks.push(group.watches[0].series);
    return answer(group);
  });
  const pullAbsent = vi.fn(async () => false);
  const complete = vi.fn((_group: WatchGroup, w: WatchEntry) => {
    watches.delete(w.key);
  });
  const schedule = new WatchSchedule({
    watches: () => [...watches.values()],
    windowMs: () => W,
    look,
    pullAbsent,
    complete,
    isHidden: () => hidden,
    now: () => Date.now()
  });
  return {
    schedule,
    watches,
    looks,
    look,
    pullAbsent,
    complete,
    answer: (fn: typeof answer) => (answer = fn),
    hide: (value: boolean) => (hidden = value)
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('when a watched series is read', () => {
  it('first at creation + 2 W', async () => {
    const r = rig([watch('Saga', 'Saga 01')]);
    r.schedule.kick();
    expect(r.schedule.nextAt).toBe(NOW + 2 * W);
    await vi.advanceTimersByTimeAsync(2 * W - 1);
    expect(r.look).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.look).toHaveBeenCalledTimes(1);
  });

  it('then at the soonest watched ETA + W, never sooner than W, never later than 15 min', async () => {
    const a = watch('Saga', 'Saga 01');
    const b = watch('Saga', 'Saga 02');
    const r = rig([a, b]);
    r.answer(() => read({ [a.key]: NOW + 2 * W + 300_000, [b.key]: NOW + 2 * W + 600_000 }));
    r.schedule.kick();
    await vi.advanceTimersByTimeAsync(2 * W);
    expect(r.schedule.nextAt).toBe(NOW + 2 * W + 300_000 + W);

    // An ETA already past: W.
    r.answer(() => read({ [a.key]: NOW, [b.key]: null }));
    await vi.advanceTimersByTimeAsync(300_000 + W);
    expect(r.schedule.nextAt).toBe(Date.now() + W);

    // No ETA at all (unpriced, claimed): 15 min. So is an ETA a day away.
    r.answer(() => read({ [a.key]: null, [b.key]: Date.now() + 86_400_000 }));
    await vi.advanceTimersByTimeAsync(W);
    expect(r.schedule.nextAt).toBe(Date.now() + WATCH_MAX_WAIT_MS);
  });

  it('one never listed is read again at 2 W, then pulled once; the 15-minute reads go on', async () => {
    const a = watch('Saga', 'Saga 01');
    const r = rig([a]);
    r.schedule.kick();
    await vi.advanceTimersByTimeAsync(2 * W);
    expect(r.pullAbsent).not.toHaveBeenCalled();
    expect(r.schedule.nextAt).toBe(Date.now() + 2 * W);
    await vi.advanceTimersByTimeAsync(2 * W);
    expect(r.pullAbsent).toHaveBeenCalledTimes(1);
    expect(r.schedule.nextAt).toBe(Date.now() + WATCH_MAX_WAIT_MS);
    await vi.advanceTimersByTimeAsync(3 * WATCH_MAX_WAIT_MS);
    expect(r.look).toHaveBeenCalledTimes(5);
    expect(r.pullAbsent).toHaveBeenCalledTimes(1);
  });

  it('done, or seen and then gone: the watch ends, and its series is read no more', async () => {
    const a = watch('Saga', 'Saga 01');
    const b = watch('Saga', 'Saga 02');
    const r = rig([a, b]);
    r.answer(() => read({ [a.key]: null }, [b.key]));
    r.schedule.kick();
    await vi.advanceTimersByTimeAsync(2 * W);
    expect(r.complete).toHaveBeenCalledTimes(1);
    expect(r.complete.mock.calls[0][1].key).toBe(b.key);
    r.answer(() => read({}));
    await vi.advanceTimersByTimeAsync(WATCH_MAX_WAIT_MS);
    expect(r.complete).toHaveBeenCalledTimes(2);
    expect(r.watches.size).toBe(0);
    expect(r.schedule.nextAt).toBeNull();
    expect(r.pullAbsent).not.toHaveBeenCalled();
  });

  it(`at most ${WATCH_ROTATION} series are read, the oldest watches first`, async () => {
    // Saga 00 is the newest watch, Saga 24 the oldest.
    const many = Array.from({ length: WATCH_ROTATION + 5 }, (_, i) =>
      watch(`Saga ${String(i).padStart(2, '0')}`, 'Vol 1', NOW - i * 1_000)
    );
    const r = rig(many);
    r.schedule.kick();
    await vi.advanceTimersByTimeAsync(2 * W);
    expect(new Set(r.looks).size).toBe(WATCH_ROTATION);
    // The five newest wait for a slot.
    for (let i = 0; i < 5; i++) expect(r.looks).not.toContain(`Saga 0${i}`);
    // A slot frees up: the next oldest is read.
    r.watches.delete(many[WATCH_ROTATION + 4].key);
    r.schedule.kick();
    await vi.advanceTimersByTimeAsync(WATCH_MAX_WAIT_MS);
    expect(r.looks).toContain('Saga 04');
    expect(r.looks).not.toContain('Saga 03');
  });

  it('a failed read backs off', async () => {
    const r = rig([watch('Saga', 'Saga 01')]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.answer(() => Promise.reject(new Error('offline')));
    r.schedule.kick();
    await vi.advanceTimersByTimeAsync(2 * W);
    expect(r.schedule.nextAt).toBe(Date.now() + WATCH_BACKOFF_MS[0]);
    await vi.advanceTimersByTimeAsync(WATCH_BACKOFF_MS[0]);
    expect(r.schedule.nextAt).toBe(Date.now() + WATCH_BACKOFF_MS[1]);
  });
});

describe('what is not read', () => {
  it('nothing while the tab is hidden; a look once it is shown again', async () => {
    const r = rig([watch('Saga', 'Saga 01')]);
    r.schedule.kick();
    r.hide(true);
    r.schedule.onVisibilityChange();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(r.look).not.toHaveBeenCalled();
    r.hide(false);
    r.schedule.onVisibilityChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.look).toHaveBeenCalledTimes(1);
  });

  it('a series handed to a v1 poller is never read again', async () => {
    const r = rig([watch('Saga', 'Saga 01')]);
    r.answer(() => ({ kind: 'handed-off' }));
    r.schedule.kick();
    await vi.advanceTimersByTimeAsync(2 * W);
    expect(r.schedule.nextAt).toBeNull();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(r.look).toHaveBeenCalledTimes(1);
  });

  it('one that cannot be read now waits 15 min, or until a wake', async () => {
    const r = rig([watch('Saga', 'Saga 01')]);
    r.answer(() => ({ kind: 'wait' }));
    r.schedule.kick();
    await vi.advanceTimersByTimeAsync(2 * W);
    expect(r.schedule.nextAt).toBe(Date.now() + WATCH_MAX_WAIT_MS);
    r.answer(() => read());
    r.schedule.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.look).toHaveBeenCalledTimes(2);
  });

  it('groups by source and folded series', () => {
    const a = watch('Saga', 'Saga 01');
    expect(watchGroupId(a)).toBe(watchGroupId({ ...a, series: ' saga ' }));
    expect(watchGroupId(a)).not.toBe(watchGroupId({ ...a, queue_url: 'cloud:onedrive' }));
  });
});
