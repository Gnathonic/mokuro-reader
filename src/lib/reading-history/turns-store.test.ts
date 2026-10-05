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
});
