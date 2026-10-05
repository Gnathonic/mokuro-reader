import Dexie from 'dexie';
import { sourceStampChanged } from '$lib/metadata/series-index';
import type {
  CloudFileMetadata,
  SyncProvider,
  UploadFileResult
} from '$lib/util/sync/provider-interface';
import type { HistoryDexie } from './history-db';
import {
  historyDeviceFilePath,
  historyMonthOf,
  historySegmentPath,
  parseHistoryPath,
  type HistoryPath
} from './paths';
import { getOrCreateDeviceId, notifyEventsRecorded } from './record';
import { decodeSegment, encodeSegment } from './segment-codec';
import type { DeviceClass, DeviceFacts, ReadingEvent } from './types';

/**
 * One reading-history pass against a provider (spec: Storage → Cloud, Import):
 *
 * 1. IMPORT every other device's listed files whose stamp changed. A segment's
 *    events are written by `[device, seq]` in one transaction with the new
 *    stamp, so re-imports, retries and duplicate listings change nothing, and
 *    a file that fails to download, decode or validate leaves the old stamp —
 *    it is retried on the next listing.
 * 2. EXPORT this device's own months whose content changed since the last
 *    upload to THIS provider (marks are per provider, so switching providers
 *    uploads everything again). The current month goes up at most every
 *    `UPLOAD_INTERVAL_MS` unless forced; closed months always go up.
 * 3. Upload this device's facts (`device.json`) when they change.
 *
 * Never uploads another device's events. Never uploads to a server that
 * compiles its own metadata (mokuro-bunko maps unknown paths into the shared
 * library) or to a read-only provider; imports still run there.
 */

export const UPLOAD_INTERVAL_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_DOWNLOADS = 4;
const DEVICE_CLASSES: DeviceClass[] = ['phone', 'tablet', 'laptop', 'desktop', 'unknown'];
const MONTH_RE = /^\d{4}-\d{2}$/;

export interface HistorySyncOptions {
  /** Upload the current month even if it went up less than UPLOAD_INTERVAL_MS ago. */
  force?: boolean;
  now?: number;
  onUploaded?: (path: string, bytes: number, result: UploadFileResult) => void;
}

export interface HistorySyncResult {
  imported: number;
  uploaded: string[];
  failed: string[];
}

interface UploadMark {
  last_seq: number;
  count: number;
  at: number;
}

export async function syncHistory(
  provider: SyncProvider,
  listing: CloudFileMetadata[],
  db: HistoryDexie,
  options: HistorySyncOptions = {}
): Promise<HistorySyncResult> {
  const now = options.now ?? Date.now();
  const own = await getOrCreateDeviceId(db);
  const result: HistorySyncResult = { imported: 0, uploaded: [], failed: [] };
  const warned = new Set<string>();
  const warnOnce = (kind: string, ...details: unknown[]) => {
    if (warned.has(kind)) return;
    warned.add(kind);
    console.warn(`[reading-history] ${kind}`, ...details);
  };

  result.imported = await importOthers(provider, listing, db, own, warnOnce);

  const status = provider.getStatus();
  if (!status.serverCompilesMetadata && !status.isReadOnly) {
    const listed = new Set(listing.map((f) => f.path));
    await exportOwnMonths(provider, db, own, listed, now, options, result, warnOnce);
    await exportOwnFacts(provider, db, own, listed, options, result, warnOnce);
  }
  return result;
}

type WarnOnce = (kind: string, ...details: unknown[]) => void;

async function importOthers(
  provider: SyncProvider,
  listing: CloudFileMetadata[],
  db: HistoryDexie,
  own: string,
  warnOnce: WarnOnce
): Promise<number> {
  // One entry per path; a duplicated file (Drive can mint two) keeps the newest.
  const byPath = new Map<string, { file: CloudFileMetadata; parsed: HistoryPath }>();
  for (const file of listing) {
    const parsed = parseHistoryPath(file.path);
    if (!parsed || parsed.device === own) continue;
    const seen = byPath.get(file.path);
    if (!seen || Date.parse(file.modifiedTime) > Date.parse(seen.file.modifiedTime)) {
      byPath.set(file.path, { file, parsed });
    }
  }

  const stale: Array<{ file: CloudFileMetadata; parsed: HistoryPath }> = [];
  for (const entry of byPath.values()) {
    const record = await db.history_files.get(entry.file.path);
    const cloud = { size: entry.file.size ?? 0, modifiedTime: entry.file.modifiedTime ?? '' };
    if (sourceStampChanged(record, cloud, provider.type)) stale.push(entry);
  }

  let imported = 0;
  await runPool(stale, MAX_CONCURRENT_DOWNLOADS, async ({ file, parsed }) => {
    // Await first: `imported += await …` reads `imported` before the await,
    // and concurrent workers would overwrite each other's counts.
    const added = await importOne(provider, db, file, parsed, warnOnce);
    imported += added;
  });
  return imported;
}

async function importOne(
  provider: SyncProvider,
  db: HistoryDexie,
  file: CloudFileMetadata,
  parsed: HistoryPath,
  warnOnce: WarnOnce
): Promise<number> {
  const stamp = {
    path: file.path,
    provider: provider.type,
    size: file.size ?? 0,
    modifiedTime: file.modifiedTime ?? ''
  };
  try {
    const bytes = new Uint8Array(await (await provider.downloadFile(file)).arrayBuffer());
    // Bytes that disagree with the listing are an older copy (an HTTP cache):
    // importing them is harmless, but stamping them would never fetch the rest.
    if (file.size > 0 && bytes.length !== file.size) {
      warnOnce('downloaded size disagrees with the listing (retried next sync)', file.path);
      return 0;
    }

    if (parsed.kind === 'device') {
      const facts = JSON.parse(new TextDecoder().decode(bytes)) as DeviceFacts;
      if (
        !facts ||
        facts.device !== parsed.device ||
        !DEVICE_CLASSES.includes(facts.class) ||
        typeof facts.first_seen !== 'string' ||
        typeof facts.last_seen !== 'string'
      ) {
        warnOnce('device file does not match its folder', file.path);
        return 0;
      }
      await db.transaction('rw', db.devices, db.history_files, async () => {
        const existing = await db.devices.get(facts.device);
        if (!existing || (facts.last_seen ?? '') > (existing.last_seen ?? '')) {
          await db.devices.put(pickFacts(facts));
        }
        await db.history_files.put({ ...stamp, last_seq: 0 });
      });
      return 0;
    }

    const { header, events } = await decodeSegment(bytes);
    const matchesPath =
      header.device === parsed.device &&
      (parsed.kind === 'legacy'
        ? header.legacy === true
        : !header.legacy &&
          header.month === parsed.month &&
          events.every((e) => historyMonthOf(e.t) === header.month));
    if (!matchesPath) {
      warnOnce('segment does not match its path', file.path);
      return 0;
    }

    let added: ReadingEvent[] = [];
    await db.transaction('rw', db.reading_events, db.history_files, async () => {
      const previous = await db.history_files.get(file.path);
      if (previous && header.last_seq < previous.last_seq) {
        // Another device rebuilt its history after losing data. Nothing here is deleted.
        warnOnce('segment went backwards', file.path, previous.last_seq, header.last_seq);
      }
      const stored = await db.reading_events.bulkGet(
        events.map((e) => [e.device, e.seq] as [string, number])
      );
      const fresh: ReadingEvent[] = [];
      events.forEach((event, i) => {
        const old = stored[i];
        if (!old) fresh.push(event);
        else if (canonical(old) !== canonical(event)) {
          // Two installs share an ID (a copied browser profile). Keep what we have.
          warnOnce('same event id, different content', event.device, event.seq);
        }
      });
      if (fresh.length > 0) await db.reading_events.bulkAdd(fresh);
      added = fresh;
      await db.history_files.put({ ...stamp, last_seq: header.last_seq });
    });
    notifyEventsRecorded(added);
    return added.length;
  } catch (error) {
    warnOnce('could not import a history file (retried next sync)', file.path, error);
    return 0;
  }
}

async function exportOwnMonths(
  provider: SyncProvider,
  db: HistoryDexie,
  own: string,
  listed: Set<string>,
  now: number,
  options: HistorySyncOptions,
  result: HistorySyncResult,
  warnOnce: WarnOnce
): Promise<void> {
  const mine = await db.reading_events
    .where('[device+seq]')
    .between([own, Dexie.minKey], [own, Dexie.maxKey])
    .toArray();
  const months = new Map<string, ReadingEvent[]>();
  for (const event of mine) {
    const month = historyMonthOf(event.t);
    const list = months.get(month);
    if (list) list.push(event);
    else months.set(month, [event]);
  }

  const current = historyMonthOf(now);
  for (const month of [...months.keys()].sort()) {
    // A clock far out of range names no month a listing could ever show;
    // uploading it would repeat on every sync.
    if (!MONTH_RE.test(month)) continue;
    const events = months.get(month)!;
    const path = historySegmentPath(own, month);
    const key = `uploaded:${provider.type}:${month}`;
    const mark = (await db.history_meta.get(key))?.value as UploadMark | undefined;
    let last_seq = 0;
    for (const event of events) if (event.seq > last_seq) last_seq = event.seq;
    const count = events.length;

    if (mark && mark.last_seq === last_seq && mark.count === count && listed.has(path)) continue;
    if (month === current && !options.force && mark && now - mark.at < UPLOAD_INTERVAL_MS) continue;

    try {
      const bytes = await encodeSegment(own, month, events);
      await upload(provider, path, bytes, options, warnOnce);
      await db.history_meta.put({ key, value: { last_seq, count, at: now } satisfies UploadMark });
      result.uploaded.push(path);
    } catch (error) {
      result.failed.push(path);
      warnOnce('could not upload a history month (retried next sync)', path, error);
    }
  }
}

async function exportOwnFacts(
  provider: SyncProvider,
  db: HistoryDexie,
  own: string,
  listed: Set<string>,
  options: HistorySyncOptions,
  result: HistorySyncResult,
  warnOnce: WarnOnce
): Promise<void> {
  const facts = await db.devices.get(own);
  if (!facts) return;
  // `last_seen` moves on every app start; it alone is no reason to upload.
  const { last_seen: _lastSeen, ...stable } = pickFacts(facts);
  const signature = JSON.stringify(stable);
  const key = `uploaded:${provider.type}:device`;
  const path = historyDeviceFilePath(own);
  const mark = (await db.history_meta.get(key))?.value as { facts: string } | undefined;
  if (mark?.facts === signature && listed.has(path)) return;

  try {
    const bytes = new TextEncoder().encode(JSON.stringify(pickFacts(facts)));
    await upload(provider, path, bytes, options, warnOnce);
    await db.history_meta.put({ key, value: { facts: signature } });
    result.uploaded.push(path);
  } catch (error) {
    result.failed.push(path);
    warnOnce('could not upload device facts (retried next sync)', path, error);
  }
}

/**
 * Upload one history file. As a `Blob` (every provider handles one; some read
 * `.size`/`.arrayBuffer()`), and through `blindUploadFile` where a provider
 * has it: on Drive the regular upload re-lists the whole account afterwards,
 * and a history file changes nothing any view renders, is retried by the next
 * sync and loses nothing on failure — the documented test for a blind write.
 * Recording the upload in the listing cache is bookkeeping: if that throws,
 * the upload still counts.
 */
async function upload(
  provider: SyncProvider,
  path: string,
  bytes: Uint8Array,
  options: HistorySyncOptions,
  warnOnce: WarnOnce
): Promise<void> {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
  const uploaded = provider.blindUploadFile
    ? await provider.blindUploadFile(path, blob)
    : await provider.uploadFile(path, blob);
  try {
    options.onUploaded?.(path, bytes.length, uploaded);
  } catch (error) {
    warnOnce('could not record an upload in the listing cache', path, error);
  }
}

/** Only the documented fields: a device file from the cloud is untrusted. */
function pickFacts(facts: DeviceFacts): DeviceFacts {
  return {
    device: facts.device,
    class: facts.class,
    ...(typeof facts.os === 'string' && { os: facts.os }),
    ...(typeof facts.browser === 'string' && { browser: facts.browser }),
    first_seen: facts.first_seen,
    last_seen: facts.last_seen
  };
}

/** Key-order-independent JSON, to compare a stored event with an imported one. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}
