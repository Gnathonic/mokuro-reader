/**
 * Reading done on ANOTHER device that this device learned of before (or
 * instead of) that device's history events: a position adopted from
 * `positions.json`, or — where history does not sync — a newer record that
 * `volume-data.json`'s merge brought in.
 *
 * Smart sort's "last read" comes from history (`last-read.ts`), and it
 * rightly ignores `lastProgressUpdate` once a volume has events: locally that
 * stamp also moves for re-stamps that are not reading. But a stamp adopted
 * from the cloud IS the other device's page turn, and its events arrive only
 * with the slow sync — or never, on a provider that does not carry history.
 * So an adopted stamp counts as a read until that device's own events cover
 * it (`uncoveredRemoteRead`); from then on history decides, look-up visits and
 * all.
 *
 * Kept in localStorage, newest `MAX_ENTRIES`: smart sort only needs the recent
 * ones, and an evicted entry falls back to whatever history says.
 */

import { readable, type Readable } from 'svelte/store';
import { stampMs } from '$lib/util/volume-helpers';
import type { ReadingEvent } from './types';

const STORAGE_KEY = 'reading-history:remote-reads';
export const MAX_ENTRIES = 500;

/**
 * The reading device's history covers an adopted stamp once one of its page
 * views ENDS at least this close to it. The stamp is that device's page turn,
 * and a turn ends the view before it at that same moment, so history that
 * knows the turn ends a view there; this absorbs the few ms between the two
 * writes. (A view's START says nothing: the previous page of a fast reader
 * starts seconds before the turn while history knows none of what followed.)
 */
export const COVER_TOLERANCE_MS = 1_000;

export interface RemoteRead {
  /** The adopted stamp, epoch ms. */
  at: number;
  /** The device that read; null = unknown (a `volume-data.json` merge). */
  device: string | null;
}

type Stored = Record<string, [number, string | null]>;

function load(): Map<string, RemoteRead> {
  const out = new Map<string, RemoteRead>();
  try {
    if (typeof window === 'undefined') return out;
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Stored;
    if (!parsed || typeof parsed !== 'object') return out;
    for (const [volume, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const [at, device] = value;
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
      out.set(volume, { at, device: typeof device === 'string' ? device : null });
    }
  } catch {
    // unreadable: start empty, history still answers
  }
  return out;
}

function save(reads: Map<string, RemoteRead>): void {
  try {
    if (typeof window === 'undefined') return;
    const stored: Stored = {};
    for (const [volume, { at, device }] of reads) stored[volume] = [at, device];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // quota / private mode: the sort falls back to history alone
  }
}

let reads: Map<string, RemoteRead> | null = null;
const listeners = new Set<(reads: ReadonlyMap<string, RemoteRead>) => void>();

function current(): Map<string, RemoteRead> {
  if (!reads) reads = load();
  return reads;
}

/** Remember another device's read of `volume` at `at`; only a newer one replaces it. */
export function noteRemoteRead(volume: string, at: number, device: string | null): void {
  noteRemoteReads([{ volume, at, device }]);
}

/** Several at once: one save, one emission. */
export function noteRemoteReads(
  incoming: Iterable<{ volume: string; at: number; device: string | null }>
): void {
  let next: Map<string, RemoteRead> | null = null;
  for (const { volume, at, device } of incoming) {
    if (!Number.isFinite(at) || at <= 0) continue;
    const prev = (next ?? current()).get(volume);
    if (prev && prev.at >= at) continue;
    next ??= new Map(current());
    next.set(volume, { at, device });
  }
  if (!next) return;
  if (next.size > MAX_ENTRIES) {
    const keep = [...next].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
    next = new Map(keep);
  }
  reads = next;
  save(next);
  for (const listener of listeners) listener(next);
}

/**
 * Where history does not sync, `volume-data.json` is the only carrier of
 * another device's reading: every record the merge moved to a newer
 * `lastProgressUpdate` than this device had came from the cloud. Whose it
 * was is unknown. (Where history syncs, the events come in the same sync and
 * judge it themselves — a re-stamp there is not a read.)
 */
export function noteMergedRemoteReads(
  before: Record<string, { lastProgressUpdate?: string } | undefined>,
  after: Record<string, { lastProgressUpdate?: string; deletedOn?: string; progress?: number }>
): void {
  const found: Array<{ volume: string; at: number; device: null }> = [];
  for (const [volume, record] of Object.entries(after)) {
    if (record.deletedOn || (record.progress ?? 0) <= 1) continue;
    const at = stampMs(record.lastProgressUpdate);
    if (at > stampMs(before[volume]?.lastProgressUpdate)) found.push({ volume, at, device: null });
  }
  noteRemoteReads(found);
}

/** Every remembered remote read; emits on each change. */
export const remoteReads: Readable<ReadonlyMap<string, RemoteRead>> = readable<
  ReadonlyMap<string, RemoteRead>
>(new Map(), (set) => {
  set(current());
  listeners.add(set);
  return () => listeners.delete(set);
});

/**
 * The remote read's time while history does not cover it yet, else 0.
 *
 * Covered = a page view of the reading device ends at the stamp: history now
 * holds that reading and judges it (a look-up there that leaked a stamp is
 * excluded again). An unknown device is never covered — history cannot say
 * whose events would cover it — so it stays a read, as the stamp always was
 * before history; newer local reading still outranks it by plain max.
 * A stamp at or before the volume's `forget` horizon was forgotten.
 */
export function uncoveredRemoteRead(
  read: RemoteRead | undefined,
  events: readonly ReadingEvent[]
): number {
  if (!read) return 0;
  let horizon = -Infinity;
  for (const e of events) if (e.kind === 'forget' && e.before > horizon) horizon = e.before;
  if (read.at <= horizon) return 0;
  if (read.device !== null) {
    const from = read.at - COVER_TOLERANCE_MS;
    for (const e of events) {
      if (e.kind !== 'page' || e.device !== read.device) continue;
      if (e.t + (e.dwell_ms ?? 0) >= from) return 0;
    }
  }
  return read.at;
}

export function _resetRemoteReadsForTests(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  reads = new Map();
  for (const listener of listeners) listener(reads);
  reads = null;
}
