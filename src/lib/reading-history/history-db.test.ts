import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { HistoryDexie } from './history-db';

describe('history db v2', () => {
  it('upgrades a v1 database in place, keeping its events', async () => {
    const name = `upgrade-${Math.random()}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({
      reading_events: '[device+seq], volume, t',
      devices: 'device',
      history_meta: 'key'
    });
    await v1
      .table('reading_events')
      .add({ device: 'd', seq: 1, t: 5, kind: 'restart', volume: 'v' });
    v1.close();

    const db = new HistoryDexie(name);
    expect(await db.reading_events.count()).toBe(1);
    await db.history_files.put({
      path: 'history/x/2026-10.events',
      provider: 'webdav',
      size: 3,
      modifiedTime: 'm',
      last_seq: 9
    });
    expect((await db.history_files.get('history/x/2026-10.events'))?.last_seq).toBe(9);
    db.close();
  });
});
