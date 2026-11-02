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
import { attachProjectedTurns, cutOverLegacyTurns } from './cut-over';
import { appendEvent } from './record';
import { _resetHistoryTurns, loadHistoryTurns } from './turns-store';
import type { PagePayload } from './types';

let db: HistoryDexie;
beforeEach(async () => {
  clearVolumes();
  _resetHistoryTurns();
  volumeOcr.get.mockResolvedValue(undefined);
  db = new HistoryDexie(`cut-${Math.random()}`);
  // The app loads the projection first; the cut-over never strips without it.
  await loadHistoryTurns(db);
});

const turns: [number, number, number][] = [
  [1000, 1, 10],
  [2000, 2, 20],
  [3000, 3, 30]
];

/** A native view of `v`: page `page` opened at `t`, on screen for `dwell` ms. */
const view = (page: number, dwell = 5000, volume = 'v'): PagePayload => ({
  kind: 'page',
  volume,
  first_page: page,
  last_page: page,
  page_chars: [10],
  chars_before: (page - 1) * 10,
  dwell_ms: dwell,
  layout: 'single',
  orientation: 'portrait',
  viewport: { w: 1, h: 1 }
});
const legacyEvents = async () =>
  (await db.reading_events.toArray()).filter((e) => e.device.startsWith('legacy:'));

describe('cutOverLegacyTurns', () => {
  it("converts a record's turns, strips them, and stats still see them", async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 3, recentPageTurns: [...turns] }) });
    const result = await cutOverLegacyTurns(db);
    expect(result).toEqual({ volumes: 1, events: 3 });
    expect(await db.reading_events.count()).toBe(3);
    expect(get(volumesWithTrash).v.recentPageTurns).toEqual([]);
    // Served at once: the projection was updated before the strip.
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
    expect(get(volumes).v.recentPageTurns).toEqual([
      [1000, 0, 2],
      [2000, 1, 4]
    ]);
  });

  it('never strips while the projection is not loaded (stats would go empty)', async () => {
    _resetHistoryTurns();
    volumesWithTrash.set({ v: new VolumeData({ progress: 3, recentPageTurns: [...turns] }) });
    await cutOverLegacyTurns(db);
    expect(get(volumesWithTrash).v.recentPageTurns).toEqual(turns);
    expect(get(volumes).v.recentPageTurns).toEqual(turns);
  });

  it('attachProjectedTurns puts converted turns back for the file, without touching the store', async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 3, recentPageTurns: [...turns] }) });
    await cutOverLegacyTurns(db);
    const forFile = await attachProjectedTurns(get(volumesWithTrash), { historySyncs: true });
    expect(forFile.v.recentPageTurns).toEqual(turns);
    expect(get(volumesWithTrash).v.recentPageTurns).toEqual([]);
  });

  it('attachProjectedTurns never puts a native view into the file of a provider that syncs history', async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 3, recentPageTurns: [...turns] }) });
    await cutOverLegacyTurns(db);
    await appendEvent(db, view(4), 10_000);
    const forFile = await attachProjectedTurns(get(volumesWithTrash), { historySyncs: true });
    // The legacy turns ride until legacy.events is confirmed; the native view
    // travels as history, so the file does not carry it.
    expect(forFile.v.recentPageTurns).toEqual(turns);
    // Where history cannot sync at all, the file is the only copy: every turn rides.
    const noHistory = await attachProjectedTurns(get(volumesWithTrash), { historySyncs: false });
    expect(noHistory.v.recentPageTurns).toEqual([...turns, [10_000, 4, 40]]);
  });

  it('a native view that comes back from the file as a turn never becomes a legacy event', async () => {
    // Sync 1: this device read natively; the file went up carrying that view as
    // a turn (an older client), and the merge brings it back into the record.
    await appendEvent(db, view(4), 10_000);
    volumesWithTrash.set({
      v: new VolumeData({ progress: 4, recentPageTurns: [[10_000, 4, 40]] })
    });
    const result = await cutOverLegacyTurns(db);
    expect(await legacyEvents()).toEqual([]);
    // Stripped all the same: the native event is that reading's record.
    expect(result).toEqual({ volumes: 1, events: 0 });
    expect(get(volumesWithTrash).v.recentPageTurns).toEqual([]);
    expect(get(volumes).v.recentPageTurns).toEqual([[10_000, 4, 40]]);
  });

  it('two syncs with native reading in between leave the legacy events alone', async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 3, recentPageTurns: [...turns] }) });
    await cutOverLegacyTurns(db);
    const first = await attachProjectedTurns(get(volumesWithTrash), { historySyncs: true });
    await appendEvent(db, view(4), 10_000);
    await appendEvent(db, view(5), 20_000);
    // Sync 2: the merge unions whatever the last file carried back into the record.
    volumesWithTrash.set({
      v: new VolumeData({ ...get(volumesWithTrash).v, recentPageTurns: first.v.recentPageTurns })
    });
    const second = await cutOverLegacyTurns(db);
    expect(second.events).toBe(0);
    expect((await legacyEvents()).map((e) => e.seq)).toEqual([1000, 2000, 3000]);
    const forFile = await attachProjectedTurns(get(volumesWithTrash), { historySyncs: true });
    expect(forFile.v.recentPageTurns).toEqual(turns);
    expect(get(volumes).v.recentPageTurns).toEqual([...turns, [10_000, 4, 40], [20_000, 5, 50]]);
  });

  it('a turn a native view covers is stripped but not converted; one it does not cover is', async () => {
    await appendEvent(db, view(2, 1000), 1500);
    volumesWithTrash.set({ v: new VolumeData({ progress: 3, recentPageTurns: [...turns] }) });
    await cutOverLegacyTurns(db);
    // The view spans 1500..2500, plus COVER_SLACK_MS either side: every turn at
    // 1000..3000 is its reading. Only a turn clear of it converts.
    expect(get(volumesWithTrash).v.recentPageTurns).toEqual([]);
    expect((await legacyEvents()).map((e) => e.seq)).toEqual([]);
    volumesWithTrash.set({ v: new VolumeData({ progress: 9, recentPageTurns: [[9000, 9, 90]] }) });
    await cutOverLegacyTurns(db);
    expect((await legacyEvents()).map((e) => e.seq)).toEqual([9000]);
  });

  it('a same-millisecond twin that did not convert stays in the record', async () => {
    volumesWithTrash.set({
      v: new VolumeData({
        progress: 2,
        recentPageTurns: [
          [1000, 1, 10],
          [1000, 2, 20],
          [2000, 3, 30]
        ]
      })
    });
    const result = await cutOverLegacyTurns(db);
    expect(result.events).toBe(2);
    expect((await legacyEvents()).map((e) => [e.seq, (e as PagePayload).first_page])).toEqual([
      [1000, 2],
      [2000, 3]
    ]);
    expect(get(volumesWithTrash).v.recentPageTurns).toEqual([[1000, 1, 10]]);
  });

  it('a turn and an archived read on the same millisecond do not stall the conversion', async () => {
    volumesWithTrash.set({
      v: new VolumeData({
        progress: 1,
        recentPageTurns: [[500, 1, 10]],
        archivedReads: [{ at: 500, pages: 1, chars: 10, completed: false }]
      }),
      w: new VolumeData({ progress: 1, recentPageTurns: [[700, 1, 10]] })
    });
    await cutOverLegacyTurns(db);
    expect(get(volumesWithTrash).w.recentPageTurns).toEqual([]);
    expect(get(volumesWithTrash).v.recentPageTurns).toEqual([]);
  });
});
