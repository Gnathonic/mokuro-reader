import Dexie, { type Table } from 'dexie';
import type { DeviceFacts, ReadingEvent } from './types';

/**
 * Reading history lives in its OWN database, not in `mokuro_v3`: it outlives
 * every catalog row, the export Worker never needs it, it stays off the
 * `MOKURO_DB_SCHEMA` ladder, and its small writes never queue behind the
 * catalog's long blob transactions.
 */
export const HISTORY_DB_NAME = 'mokuro_history';

export interface HistoryMeta {
  key: string;
  value: unknown;
}

export class HistoryDexie extends Dexie {
  reading_events!: Table<ReadingEvent, [string, number]>;
  devices!: Table<DeviceFacts, string>;
  history_meta!: Table<HistoryMeta, string>;

  constructor(name: string = HISTORY_DB_NAME) {
    super(name);
    this.version(1).stores({
      reading_events: '[device+seq], volume, t',
      devices: 'device',
      history_meta: 'key'
    });
  }
}

let defaultDb: HistoryDexie | null = null;

/** The app's history database, created on first use. */
export function historyDb(): HistoryDexie {
  return (defaultDb ??= new HistoryDexie());
}
