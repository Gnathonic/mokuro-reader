import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { HistoryDexie } from './history-db';
import { appendEvent, recordEvent } from './record';
import {
  _resetHistoryTurns,
  getHistoryTurns,
  historyTurns,
  historyTurnsLoaded,
  loadHistoryTurns
} from './turns-store';

const view = (volume: string, page: number) => ({
  kind: 'page' as const,
  volume,
  first_page: page,
  last_page: page,
  page_chars: [10],
  chars_before: page * 10,
  dwell_ms: 1000,
  layout: 'single' as const,
  orientation: 'portrait' as const,
  viewport: { w: 1, h: 1 }
});

let db: HistoryDexie;
beforeEach(() => {
  _resetHistoryTurns();
  db = new HistoryDexie(`turns-${Math.random()}`);
});

describe('projected turns store', () => {
  it('is unknown until loaded', () => {
    expect(historyTurnsLoaded()).toBe(false);
    expect(getHistoryTurns('v')).toBeUndefined();
  });

  it('loads every event and projects per volume', async () => {
    await appendEvent(db, view('v', 1), 1000);
    await appendEvent(db, view('v', 2), 5000);
    await loadHistoryTurns(db);
    expect(historyTurnsLoaded()).toBe(true);
    expect(get(historyTurns).get('v')).toEqual([
      [1000, 1, 20],
      [5000, 2, 30]
    ]);
    expect(getHistoryTurns('other')).toBeUndefined();
  });

  it('follows newly recorded events without a reload', async () => {
    await loadHistoryTurns(db);
    const seen: number[] = [];
    const stop = historyTurns.subscribe((m) => seen.push(m.get('v')?.length ?? 0));
    await recordEvent(view('v', 3), 9000, db);
    expect(getHistoryTurns('v')).toEqual([[9000, 3, 40]]);
    expect(seen.at(-1)).toBe(1);
    stop();
  });

  it('a failed append notifies nothing', async () => {
    await loadHistoryTurns(db);
    db.close();
    await recordEvent(view('v', 4), 9500, db);
    expect(getHistoryTurns('v')).toBeUndefined();
  });

  it('an event stored while the initial load is reading is not lost', async () => {
    await appendEvent(db, view('v', 1), 1000);
    // Hold the load after its read, so a later commit lands mid-load.
    const original = db.reading_events.toArray.bind(db.reading_events);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let read!: () => void;
    const readDone = new Promise<void>((r) => (read = r));
    db.reading_events.toArray = (async () => {
      const all = await original();
      read();
      await gate;
      return all;
    }) as typeof original;
    const loading = loadHistoryTurns(db);
    await readDone;
    await recordEvent(view('v', 2), 2000, db);
    release();
    await loading;
    await Promise.resolve();
    expect(getHistoryTurns('v')).toEqual([
      [1000, 1, 20],
      [2000, 2, 30]
    ]);
  });

  it('keeps restart and position events for a volume, and says which volumes changed', async () => {
    const { getVolumeEvents, onHistoryChanged } = await import('./turns-store');
    await loadHistoryTurns(db);
    const changed: Array<Set<string> | 'all'> = [];
    const stop = onHistoryChanged((v) => changed.push(v));
    await recordEvent({ kind: 'restart', volume: 'r' }, 1000, db);
    await recordEvent(
      { kind: 'position', volume: 'r', answer: 'stay', through: 5, page: 3 },
      2000,
      db
    );
    await Promise.resolve();
    expect(
      getVolumeEvents('r')
        .map((e) => e.kind)
        .sort()
    ).toEqual(['position', 'restart']);
    expect(changed.at(-1)).toEqual(new Set(['r']));
    stop();
  });

  it('a full load reports every volume as changed', async () => {
    const { onHistoryChanged } = await import('./turns-store');
    const changed: Array<Set<string> | 'all'> = [];
    const stop = onHistoryChanged((v) => changed.push(v));
    await loadHistoryTurns(db);
    expect(changed).toEqual(['all']);
    stop();
  });
});
