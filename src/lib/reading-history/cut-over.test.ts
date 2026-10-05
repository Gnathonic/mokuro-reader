import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
const volumeOcr = vi.hoisted(() => ({
  get: vi.fn(async (_id: string): Promise<unknown> => undefined)
}));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { get: vi.fn(async () => undefined), bulkGet: vi.fn(async () => []) },
    volume_ocr: volumeOcr
  }
}));

import { get } from 'svelte/store';
import { VolumeData, clearVolumes, volumes, volumesWithTrash } from '$lib/settings/volume-data';
import { HistoryDexie } from './history-db';
import { cutOverLegacyTurns } from './cut-over';
import { _resetHistoryTurns, loadHistoryTurns } from './turns-store';

let db: HistoryDexie;
beforeEach(() => {
  clearVolumes();
  _resetHistoryTurns();
  volumeOcr.get.mockResolvedValue(undefined);
  db = new HistoryDexie(`cut-${Math.random()}`);
});

const turns: [number, number, number][] = [
  [1000, 1, 10],
  [2000, 2, 20],
  [3000, 3, 30]
];

describe('cutOverLegacyTurns', () => {
  it("converts a record's turns, strips them, and stats still see them", async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 3, recentPageTurns: [...turns] }) });
    const result = await cutOverLegacyTurns(db);
    expect(result).toEqual({ volumes: 1, events: 3 });
    expect(await db.reading_events.count()).toBe(3);
    expect(get(volumesWithTrash).v.recentPageTurns).toEqual([]);
    await loadHistoryTurns(db);
    expect(get(volumes).v.recentPageTurns).toEqual(turns);
  });

  it('keeps archived reads in the record and records them as restarts', async () => {
    volumesWithTrash.set({
      v: new VolumeData({
        progress: 1,
        archivedReads: [{ at: 500, pages: 10, chars: 100, completed: true }]
      })
    });
    await cutOverLegacyTurns(db);
    expect(get(volumesWithTrash).v.archivedReads).toHaveLength(1);
    expect((await db.reading_events.toArray()).map((e) => e.kind)).toEqual(['restart']);
  });

  it('never strips a turn that arrived after the conversion read the record', async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 3, recentPageTurns: [...turns] }) });
    const original = db.reading_events.bulkAdd.bind(db.reading_events);
    db.reading_events.bulkAdd = (async (...args: Parameters<typeof original>) => {
      volumesWithTrash.update((all) => ({
        ...all,
        v: new VolumeData({ ...all.v, recentPageTurns: [...all.v.recentPageTurns, [4000, 4, 40]] })
      }));
      return original(...args);
    }) as typeof original;
    await cutOverLegacyTurns(db);
    expect(get(volumesWithTrash).v.recentPageTurns).toEqual([[4000, 4, 40]]);
  });

  it('keeps the turns when the history database fails', async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 3, recentPageTurns: [...turns] }) });
    db.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cutOverLegacyTurns(db);
    warn.mockRestore();
    expect(get(volumesWithTrash).v.recentPageTurns).toEqual(turns);
  });

  it('is idempotent', async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 3, recentPageTurns: [...turns] }) });
    await cutOverLegacyTurns(db);
    volumesWithTrash.set({ v: new VolumeData({ progress: 3, recentPageTurns: [...turns] }) });
    const again = await cutOverLegacyTurns(db);
    expect(again.events).toBe(0);
    expect(await db.reading_events.count()).toBe(3);
  });

  it('upgrades 2-tuple turns with character counts when the volume is installed', async () => {
    volumeOcr.get.mockResolvedValue({
      pages: [{ blocks: [{ lines: ['ab'] }] }, { blocks: [{ lines: ['cde'] }] }]
    });
    volumesWithTrash.set({
      v: new VolumeData({
        progress: 1,
        recentPageTurns: [
          [1000, 0],
          [2000, 1]
        ] as never
      })
    });
    await cutOverLegacyTurns(db);
    await loadHistoryTurns(db);
    expect(get(volumes).v.recentPageTurns).toEqual([
      [1000, 0, 2],
      [2000, 1, 4]
    ]);
  });
});
