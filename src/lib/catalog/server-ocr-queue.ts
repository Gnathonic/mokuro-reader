import { db } from '$lib/catalog/db';
import { resolveBunkoLink } from '$lib/util/bunko-links';
import { fetchWithRetryAfter } from '$lib/util/sync/providers/webdav/webdav-retry-after';
import { getLayerMeta } from '$lib/catalog/layer-store';
import { volumesForFoldedSeriesTitle } from '$lib/catalog/volumes-by-series';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import {
  confineManifestToOrigins,
  loadVolumeManifest,
  type ManifestPendingJob,
  type VolumeManifest
} from '$lib/import/deep-link-manifest';
import type { FetchedLayerFile } from '$lib/metadata/layer-sync';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import type { VolumeMetadata } from '$lib/types';
import { assertNoRedirectEscape } from '$lib/util/link-safety';
import type { ProviderType, SyncProvider } from '$lib/util/sync/provider-interface';
import { validParts } from '$lib/reader/edit/ocr-label';
import {
  authFromCredentials,
  bearerOf,
  webdavAuthorization
} from '$lib/util/sync/core/providers/webdav-authorization';
import { cloudBunkoHolder, refreshCloudBunkoMarker } from './cloud-bunko-marker';
import {
  followSeriesQueue as followSeriesQueueLoop,
  lookSeriesQueue,
  resetSeriesQueueLoopForTest,
  seriesQueueFollower,
  type SeriesQueueEnv
} from './series-queue-loop';
import {
  parseSeriesQueueFile,
  pickTrustedCopy,
  seriesQueueSlice,
  type SeriesQueueBlock,
  type SeriesQueueFile
} from './series-queue';
import { WatchSchedule, type WatchGroup, type WatchLook } from './series-queue-watch';
import { SERIES_QUEUE_FILE_NAME } from '$lib/util/sync/syncable-file';
import {
  isVolumeShown,
  queueStatusStore,
  resetSeriesQueueStoreForTest,
  setShownListener,
  volumeQueueKey,
  watchedKeyStore,
  type QueueHeld,
  type QueueJob,
  type VolumeQueueStatus
} from './server-ocr-pending';

/**
 * Addendum C: ONE poller per bunko server reads its queue file,
 * `<dav root>/.mokuro-queue.json`, and that file alone drives both the
 * "Server OCR" status on volume cards and the pull of finished volumes.
 *
 * - Polls only while a volume of interest could be pending: volumes this
 *   device uploaded there, deep-link imports whose manifest had pending jobs
 *   (both "watched", persisted), and volumes the catalog is showing.
 * - Started by an upload or a deep-link import (at once), by app start or a
 *   WebDAV login to a bunko server, and by the tab becoming visible (one
 *   poll); then every `next_check_after` s
 *   (floor 30 s) with `If-None-Match`; stops when no volume of interest is in
 *   the file. Errors back off 60 s → 10 min. Paused while the tab is hidden.
 * - A volume of interest that leaves the file is done: its new sidecars are
 *   pulled once through its manifest — the primary through the cloud OCR
 *   upgrade, layers through the shared layer importer. One pull per volume in
 *   flight at a time.
 * - The file lists only the running volumes and the next hundred waiting
 *   (`pending_volumes` counts them all), so absence alone is not completion:
 *   the volume's manifest decides. One that still has jobs there stays
 *   watched, shows the manifest's jobs, and is asked again at its
 *   `recheck_after`.
 *
 * Queue file v2 (bunko `docs/design/queue-file-v2.md`) moved the queue into
 * one file per series folder, read only while that series' page is open
 * (`series-queue-loop.ts`, wired here by `followSeriesQueue`). A finished
 * volume is pulled by listing its one series (`SeriesPulls`, §8.6), and the
 * watched volumes' series files are read on their own schedule
 * (`series-queue-watch.ts`, §8.7). What stays of this poller is the kept v1
 * path: a Bunko server older than v2 (a 404 for a series file), for the
 * session. No queue file is read at app start any more, and none from a
 * cloud library: a cloud-direct Bunko writes no root queue file. Its lease marker
 * `.mokuro-bunko.json` is still read every `ttl/3` while the tab is visible
 * (`MarkerPoller`): it decides `serverCompilesMetadata`, the lease holder and
 * the queue's work clock.
 *
 * Replaces the per-volume recheck timers of Addendum A (their persisted
 * entries are removed once, `cleanupLegacyRecheckEntries`).
 */

// ---------------------------------------------------------------- the file

export interface QueueVolume {
  series: string;
  volume: string;
  /** Absolute-path URL of the archive. */
  path: string;
  /** Absolute-path URL of the volume's manifest. */
  manifest: string;
  jobs: QueueJob[];
}

export interface QueueFile {
  version: 1;
  generated_at: string;
  held: QueueHeld | null;
  /** Seconds until the server suggests looking again; null when the queue is empty. */
  next_check_after: number | null;
  /**
   * Waiting volumes in the WHOLE queue; `volumes` lists the running ones and
   * only the next hundred waiting. Null from a server that lists everything.
   */
  pending_volumes: number | null;
  volumes: QueueVolume[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function readJob(v: unknown): QueueJob | null {
  if (!isObject(v)) return null;
  const { kind, id, state, eta, progress } = v;
  if (kind !== 'ocr' && kind !== 'layer') return null;
  if (typeof id !== 'string' || !id) return null;
  if (state !== 'running' && state !== 'queued' && state !== 'held') return null;
  const parts = validParts(v.parts);
  return {
    kind,
    id,
    state,
    eta: typeof eta === 'string' && Number.isFinite(Date.parse(eta)) ? eta : null,
    progress: typeof progress === 'number' && Number.isFinite(progress) ? progress : null,
    // Only names the line: malformed parts fall back to the id, the job stays.
    ...(parts ? { parts } : {})
  };
}

/**
 * Validate a queue file (version 1: a Bunko server's root file over HTTP). A
 * malformed entry or job is dropped on its own. No Bunko stores one in a cloud
 * library any more (queue file v2): the cloud copy's fields are gone.
 */
export function parseQueueFile(json: unknown): QueueFile | null {
  if (!isObject(json) || json.version !== 1 || !Array.isArray(json.volumes)) return null;
  const volumes: QueueVolume[] = [];
  for (const v of json.volumes) {
    if (!isObject(v)) continue;
    const { series, volume, path, manifest, jobs } = v;
    if (typeof series !== 'string' || typeof volume !== 'string') continue;
    volumes.push({
      series,
      volume,
      path: typeof path === 'string' ? path : '',
      manifest: typeof manifest === 'string' ? manifest : '',
      jobs: Array.isArray(jobs) ? jobs.map(readJob).filter((j): j is QueueJob => j !== null) : []
    });
  }
  const held =
    isObject(json.held) && typeof json.held.reason === 'string'
      ? { reason: json.held.reason }
      : null;
  const next = json.next_check_after;
  const pending = json.pending_volumes;
  return {
    version: 1,
    generated_at: typeof json.generated_at === 'string' ? json.generated_at : '',
    held,
    next_check_after: typeof next === 'number' && Number.isFinite(next) && next >= 0 ? next : null,
    pending_volumes:
      typeof pending === 'number' && Number.isInteger(pending) && pending >= 0 ? pending : null,
    volumes
  };
}

/** A volume missing from the file is still being OCR'd per its manifest: what to show, when to ask again. */
export interface PendingOnServer {
  series: string;
  volume: string;
  pending: ManifestPendingJob[];
  /** Seconds, from the manifest; null when it named none. */
  recheckAfter: number | null;
}

function isPendingOnServer(v: unknown): v is PendingOnServer {
  return isObject(v) && Array.isArray(v.pending) && v.pending.length > 0;
}

// ---------------------------------------------------------------- the poller

/** Waits after the 1st, 2nd, … consecutive failure; the last repeats. */
export const QUEUE_BACKOFF_MS: readonly number[] = [60_000, 120_000, 240_000, 480_000, 600_000];
const MIN_INTERVAL_S = 30;
const UNPRICED_INTERVAL_S = 300;

export type PollTrigger = 'upload' | 'deep-link' | 'start' | 'visible' | 'shown' | 'changed';

/** What a {@link QueueSource} read produced. */
export interface QueueSourceRead {
  /** The file, or null when the source has no file it trusts right now (shown as nothing). */
  file: QueueFile | null;
  /** Hand back as `prev.etag` next time. */
  etag: string | null;
}

/** Where a poller's queue file comes from: a bunko SERVER over HTTP (`httpQueueSource`). */
export interface QueueSource {
  /** The poller's key: the queue URL. */
  id: string;
  /**
   * One read. `'not-modified'`: the previous file stands. `'unavailable'`:
   * the account the source needs is gone — the poller stops until triggered.
   * Throws on a failed read (the poller backs off).
   */
  read(prev: {
    etag: string | null;
    file: QueueFile | null;
  }): Promise<QueueSourceRead | 'not-modified' | 'unavailable'>;
}

export interface QueuePollerDeps {
  /** Where the file comes from; when omitted, `queueUrl` over HTTP (`requestInit` + `fetch`). */
  source?: QueueSource;
  queueUrl?: string;
  /** Fetch options (auth); null when the account it needs is not available. */
  requestInit?: () => Promise<RequestInit | null>;
  /** Keys of the volumes watched on this server (uploads, deep links). */
  watchedKeys: () => string[];
  /** Is the catalog showing this volume? */
  isShown: (key: string) => boolean;
  /** The file as last read; null when polling stops (nothing to show from it). */
  onStatus: (file: QueueFile | null) => void;
  /**
   * A volume of interest is done: it is no longer in the file, and its
   * manifest decides — the jobs are done (pulled), or it answers what is
   * still pending there.
   */
  onDone: (
    key: string,
    entry: QueueVolume | undefined
  ) => void | Promise<boolean | PendingOnServer | void>;
  isHidden: () => boolean;
  fetch?: typeof fetch;
}

/** The queue file of a bunko SERVER, over HTTP with `If-None-Match`. */
export function httpQueueSource(
  queueUrl: string,
  requestInit: () => Promise<RequestInit | null>,
  fetchImpl?: typeof fetch
): QueueSource {
  return {
    id: queueUrl,
    async read(prev) {
      const init = await requestInit();
      if (!init) return 'unavailable';
      const headers: Record<string, string> = {
        ...((init.headers as Record<string, string> | undefined) ?? {})
      };
      if (prev.etag && prev.file) headers['If-None-Match'] = prev.etag;
      const doFetch = fetchImpl ?? fetch;
      const response = await doFetch(queueUrl, { ...init, cache: 'no-store', headers });
      if (response.status === 304 && prev.file) return 'not-modified';
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const file = parseQueueFile(await response.json());
      if (!file) throw new Error('not a version 1 queue file');
      return { file, etag: response.headers.get('ETag') };
    }
  };
}

export class QueuePoller {
  private etag: string | null = null;
  private lastFile: QueueFile | null = null;
  /** Interesting keys seen in the last file, with their entries (for the pull). */
  private seen = new Map<string, QueueVolume>();
  /**
   * Volumes of interest the file does not list but whose manifest still has
   * jobs: when to ask the manifest again, and the entry shown meanwhile.
   */
  private offList = new Map<string, { until: number; volume: QueueVolume }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fetching = false;
  private again = false;
  private paused = false;
  private errors = 0;
  private delay: number | null = null;
  private readonly source: QueueSource;
  lastPollAt = 0;

  constructor(private readonly deps: QueuePollerDeps) {
    if (deps.source) {
      this.source = deps.source;
    } else {
      if (!deps.queueUrl || !deps.requestInit) {
        throw new Error('QueuePoller needs a source, or a queueUrl and requestInit');
      }
      this.source = httpQueueSource(deps.queueUrl, deps.requestInit, deps.fetch);
    }
  }

  get id(): string {
    return this.source.id;
  }

  get state(): 'idle' | 'waiting' | 'fetching' | 'paused' {
    if (this.fetching) return 'fetching';
    if (this.paused) return 'paused';
    return this.timer ? 'waiting' : 'idle';
  }

  /** The wait before the next scheduled poll, or null when none is scheduled. */
  get nextDelayMs(): number | null {
    return this.timer ? this.delay : null;
  }

  trigger(_reason: PollTrigger): void {
    if (this.deps.isHidden()) {
      this.clearTimer();
      this.paused = true;
      return;
    }
    if (this.fetching) {
      this.again = true;
      return;
    }
    this.clearTimer();
    void this.poll();
  }

  onVisibilityChange(): void {
    if (this.deps.isHidden()) {
      if (this.timer || this.fetching) this.paused = true;
      this.clearTimer();
      return;
    }
    const wasPaused = this.paused;
    this.paused = false;
    // Visible again: one look (a paused loop resumes from it).
    if (wasPaused || !this.fetching) this.trigger('visible');
  }

  stop(): void {
    this.clearTimer();
    this.paused = false;
    this.again = false;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.delay = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.delay = ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.delay = null;
      void this.poll(); // (a hidden tab pauses there)
    }, ms);
  }

  private async poll(): Promise<void> {
    if (this.deps.isHidden()) {
      this.paused = true;
      return;
    }
    this.fetching = true;
    this.lastPollAt = Date.now();
    try {
      let result: Awaited<ReturnType<QueueSource['read']>>;
      try {
        result = await this.source.read({ etag: this.etag, file: this.lastFile });
      } catch (error) {
        const wait = QUEUE_BACKOFF_MS[Math.min(this.errors, QUEUE_BACKOFF_MS.length - 1)];
        this.errors++;
        console.warn(
          `[OCR queue] ${this.source.id} unavailable; next look in ${wait / 1000} s:`,
          error instanceof Error ? error.message : error
        );
        this.schedule(wait);
        return;
      }
      this.errors = 0;
      if (result === 'unavailable') {
        this.halt();
        return;
      }
      if (result !== 'not-modified') {
        this.etag = result.etag;
        this.lastFile = result.file;
      }
      if (this.lastFile) this.evaluate(this.lastFile);
      else this.halt();
    } finally {
      this.fetching = false;
      if (this.again) {
        this.again = false;
        this.clearTimer();
        void this.poll();
      }
    }
  }

  private evaluate(file: QueueFile): void {
    const inFile = new Map<string, QueueVolume>();
    for (const v of file.volumes) inFile.set(volumeQueueKey(v.series, v.volume), v);
    const watched = this.deps.watchedKeys();
    const watchedSet = new Set(watched);

    const interesting = new Map<string, QueueVolume>();
    for (const [key, v] of inFile) {
      if (watchedSet.has(key) || this.deps.isShown(key)) interesting.set(key, v);
    }
    // Listed again, or no longer of interest: the manifest's word is moot.
    for (const key of [...this.offList.keys()]) {
      if (inFile.has(key) || !(watchedSet.has(key) || this.deps.isShown(key))) {
        this.offList.delete(key);
      }
    }
    // Maybe done: interesting last time and gone now, or watched and not in
    // the file (a watched volume is queued before its upload is answered, so
    // it may never have been seen pending). The manifest decides; one it
    // already called pending is asked again only at its recheck time.
    const now = Date.now();
    const doneKeys = new Set<string>();
    for (const key of this.seen.keys()) if (!inFile.has(key)) doneKeys.add(key);
    for (const key of watched) if (!inFile.has(key)) doneKeys.add(key);
    for (const key of this.offList.keys()) doneKeys.add(key);
    for (const [key, off] of this.offList) if (off.until > now) doneKeys.delete(key);
    const previous = this.seen;
    this.seen = interesting;

    this.publishOrHalt();
    for (const key of doneKeys) {
      const entry = previous.get(key) ?? this.offList.get(key)?.volume;
      const outcome = this.deps.onDone(key, entry);
      if (outcome instanceof Promise) {
        void outcome.then(
          (result) => this.settleDone(key, result),
          () => {}
        );
      }
    }
  }

  /** The manifest's answer for a volume the file stopped listing. */
  private settleDone(key: string, result: boolean | PendingOnServer | void): void {
    if (!isPendingOnServer(result)) {
      if (this.offList.delete(key)) this.publishOrHalt();
      return;
    }
    const wait = Math.max(MIN_INTERVAL_S, result.recheckAfter ?? UNPRICED_INTERVAL_S);
    this.offList.set(key, {
      until: Date.now() + wait * 1000,
      volume: {
        series: result.series,
        volume: result.volume,
        path: '',
        manifest: '',
        jobs: result.pending.map((job) => ({
          kind: job.kind,
          id: job.id,
          state: 'queued' as const,
          eta: job.eta,
          progress: null
        }))
      }
    });
    if (!this.fetching) this.publishOrHalt();
  }

  /** Show the last file (plus the volumes only their manifests still call pending), or stop. */
  private publishOrHalt(): void {
    const file = this.lastFile;
    if (!file || (this.seen.size === 0 && this.offList.size === 0)) {
      this.halt();
      return;
    }
    const listed = new Set(file.volumes.map((v) => volumeQueueKey(v.series, v.volume)));
    const extra = [...this.offList.entries()]
      .filter(([key]) => !listed.has(key))
      .map(([, off]) => off.volume);
    this.deps.onStatus(extra.length > 0 ? { ...file, volumes: [...file.volumes, ...extra] } : file);
    if (!this.timer) {
      let wait = this.intervalMs(file);
      for (const off of this.offList.values()) {
        wait = Math.min(wait, Math.max(MIN_INTERVAL_S * 1000, off.until - Date.now()));
      }
      this.schedule(wait);
    }
  }

  /** `next_check_after` (or the unpriced default), never under 30 s. */
  private intervalMs(file: QueueFile | null): number {
    return Math.max(MIN_INTERVAL_S, file?.next_check_after ?? UNPRICED_INTERVAL_S) * 1000;
  }

  /** Nothing of interest: no timer, nothing shown from this file until the next trigger. */
  private halt(): void {
    this.clearTimer();
    this.deps.onStatus(null);
  }
}

// ---------------------------------------------------------------- status for the views

const statusByQueue = new Map<string, Record<string, VolumeQueueStatus>>();

/** Publish one server's file (or withdraw it with null) into the store the cards read. */
export function publishQueueStatus(queueUrl: string, file: QueueFile | null): void {
  if (file) {
    const mine: Record<string, VolumeQueueStatus> = {};
    for (const v of file.volumes) {
      if (v.jobs.length === 0) continue;
      mine[volumeQueueKey(v.series, v.volume)] = { jobs: v.jobs, held: file.held };
    }
    statusByQueue.set(queueUrl, mine);
  } else {
    statusByQueue.delete(queueUrl);
  }
  const merged: Record<string, VolumeQueueStatus> = {};
  for (const part of statusByQueue.values()) Object.assign(merged, part);
  queueStatusStore.set(merged);
}

// ---------------------------------------------------------------- watched volumes

export const LEGACY_RECHECK_KEY = 'server-ocr-rechecks:v1';
const WATCH_KEY = 'server-ocr-watch:v1';
/** A watch that never resolved (server gone, volume never finished) lapses. */
const WATCH_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface WatchEntry {
  key: string;
  volume_uuid: string;
  series: string;
  volume: string;
  queue_url: string;
  manifest_url: string;
  /**
   * `webdav` = as the connected WebDAV account (same origin only); `none` =
   * anonymous; `cloud` = a cloud-direct Bunko's series files on the connected
   * provider (`queue_url` is then `cloud:<provider>`, `manifest_url` is
   * empty). Every kind is read on the watch schedule (queue file v2); only a
   * server older than v2 is polled through its root file.
   */
  auth: 'webdav' | 'none' | 'cloud';
  /** The `cloud.provider` stamp a pulled layer row gets. */
  source: string;
  added_at: number;
}

let watches: Map<string, WatchEntry> | null = null;

function isWatch(v: unknown): v is WatchEntry {
  const w = v as WatchEntry;
  return (
    isObject(v) &&
    typeof w.key === 'string' &&
    typeof w.volume_uuid === 'string' &&
    typeof w.series === 'string' &&
    typeof w.volume === 'string' &&
    typeof w.queue_url === 'string' &&
    typeof w.manifest_url === 'string' &&
    (w.auth === 'webdav' || w.auth === 'none' || w.auth === 'cloud') &&
    typeof w.source === 'string' &&
    typeof w.added_at === 'number'
  );
}

function loadWatches(): Map<string, WatchEntry> {
  if (watches) return watches;
  watches = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(WATCH_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    const now = Date.now();
    if (Array.isArray(parsed)) {
      for (const w of parsed) {
        if (isWatch(w) && now - w.added_at < WATCH_LIFETIME_MS) watches.set(w.key, w);
      }
    }
  } catch {
    // Unreadable: nothing watched; the listing sync still delivers layers.
  }
  publishWatchedKeys();
  return watches;
}

/** How long a burst of watch changes (a bulk upload) settles before it is written. */
export const WATCH_SAVE_DEBOUNCE_MS = 1_000;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The watches changed: the cards hear it now, storage within a second. A bulk
 * upload adds a watch per volume, and writing every watch on every one of
 * them was quadratic; one write per burst is not. A hidden tab writes at once
 * (`flushWatches`), so closing it loses nothing.
 */
function saveWatches(): void {
  publishWatchedKeys();
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeWatches();
  }, WATCH_SAVE_DEBOUNCE_MS);
}

/** Write a pending watch change now (the tab is being hidden or closed). */
export function flushWatches(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  writeWatches();
}

function writeWatches(): void {
  try {
    const list = [...(watches?.values() ?? [])];
    if (list.length === 0) globalThis.localStorage?.removeItem(WATCH_KEY);
    else globalThis.localStorage?.setItem(WATCH_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: the watch lasts this session.
  }
}

function publishWatchedKeys(): void {
  const byUuid: Record<string, string> = {};
  for (const w of watches?.values() ?? []) byUuid[w.volume_uuid] = w.key;
  watchedKeyStore.set(byUuid);
}

/** Every live watch; one past its lifetime lapses here. */
export function watchedEntries(): WatchEntry[] {
  const all = loadWatches();
  const now = Date.now();
  let lapsed = false;
  for (const [key, w] of all) {
    if (now - w.added_at >= WATCH_LIFETIME_MS) {
      all.delete(key);
      lapsed = true;
    }
  }
  if (lapsed) saveWatches();
  return [...all.values()];
}

/** End a watch (its volume is done, or gone). */
function dropWatch(key: string): void {
  if (loadWatches().delete(key)) saveWatches();
  withdrawLinkStatus(key);
}

/** The Addendum A per-volume rechecks are gone: drop what they persisted. Idempotent. */
export function cleanupLegacyRecheckEntries(): void {
  try {
    globalThis.localStorage?.removeItem(LEGACY_RECHECK_KEY);
  } catch {
    // Storage unavailable: nothing to clean.
  }
}

export interface WatchInput {
  volumeUuid: string;
  /** The volume's names ON THE SERVER (folder / archive stem), as the queue file spells them. */
  series: string;
  volume: string;
  queueUrl: string;
  manifestUrl: string;
  auth: WatchEntry['auth'];
  source: string;
}

/**
 * A volume this device just uploaded, which the server queued for OCR: watched
 * on the connected bunko server's queue under its server-side names.
 */
export async function watchUploadedVolume(input: {
  volumeUuid: string;
  series: string;
  volume: string;
  manifestUrl: string;
}): Promise<void> {
  const queueUrl = await connectedBunkoQueueUrl();
  if (!queueUrl) return;
  watchServerOcr({ ...input, queueUrl, auth: 'webdav', source: 'webdav' });
}

/**
 * A volume this device just uploaded to a CLOUD library (Drive, OneDrive,
 * MEGA, plain WebDAV, a Local Folder) while a cloud-direct Bunko's marker is
 * fresh there and carries `series_queue`: the PUT answers nothing about OCR,
 * so the volume is watched by `(series, volume)`; its series file says when
 * it is done. No such marker → no watch.
 */
export async function watchCloudUpload(input: {
  volumeUuid: string;
  series: string;
  volume: string;
}): Promise<void> {
  const providerType = await connectedCloudLibrary();
  if (!providerType) return;
  const { cloudBunkoHolder } = await import('./cloud-bunko-marker');
  if (!cloudBunkoHolder(providerType)?.series_queue) return;
  watchServerOcr({
    ...input,
    queueUrl: `cloud:${providerType}`,
    manifestUrl: '',
    auth: 'cloud',
    source: providerType
  });
}

/**
 * Watch a volume the server is making OCR for. Its series file is read on the
 * watch schedule (`series-queue-watch.ts`), and by its series page while that
 * is open; a server already known to be older than queue file v2 is polled
 * at once instead, through its root file.
 */
export function watchServerOcr(input: WatchInput, options: { start?: boolean } = {}): void {
  const key = volumeQueueKey(input.series, input.volume);
  loadWatches().set(key, {
    key,
    volume_uuid: input.volumeUuid,
    series: input.series,
    volume: input.volume,
    queue_url: input.queueUrl,
    manifest_url: input.manifestUrl,
    auth: input.auth,
    source: input.source,
    added_at: Date.now()
  });
  saveWatches();
  if (options.start === false) return;
  if (input.auth !== 'cloud' && v1Servers.has(input.queueUrl)) {
    pollerFor(input.queueUrl, input.auth, input.source).trigger(
      input.source === 'html-download' ? 'deep-link' : 'upload'
    );
    return;
  }
  watchSchedule().kick();
}

// ---------------------------------------------------------------- pulling

/** How a pull reaches the server. */
export interface PullTarget {
  queueUrl: string;
  init: RequestInit;
  source: string;
  /** Whose account `init` carries (a refused token is then replaced once). */
  auth?: WatchEntry['auth'];
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * `fetch` for a request on behalf of a queue's account: the WebDAV session's
 * Authorization goes ONLY to the queue's own origin (a manifest may name files
 * anywhere), a 401 under a bearer token replaces the token once — through
 * the provider's single-flight re-issue — and retries with the fresh header,
 * and a short 503 + Retry-After is waited out (`fetchWithRetryAfter`).
 */
export async function fetchWithQueueAuth(
  url: string,
  init: RequestInit,
  queueUrl: string,
  auth: WatchEntry['auth'] = 'none',
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string> | undefined) ?? {})
  };
  if (headers.Authorization && originOf(url) !== originOf(queueUrl)) delete headers.Authorization;
  return fetchWithRetryAfter(fetchImpl, url, { ...init, headers }, async (sent) => {
    if (auth !== 'webdav' || !bearerOf(sent.Authorization)) return null;
    const provider = (await activeWebdavProvider()) as {
      reissueAfterUnauthorized?: (stale: string) => Promise<boolean>;
    } | null;
    if (
      !provider?.reissueAfterUnauthorized ||
      !(await provider.reissueAfterUnauthorized(sent.Authorization))
    ) {
      return null;
    }
    const fresh = (await requestInitFor(queueUrl, auth))?.headers as
      Record<string, string> | undefined;
    const retryHeaders = { ...sent };
    if (fresh?.Authorization) retryHeaders.Authorization = fresh.Authorization;
    else delete retryHeaders.Authorization;
    return retryHeaders;
  });
}

/**
 * The `source` of a deep link's watch (`DEEP_LINK_LAYER_SOURCE`, spelled out:
 * importing it would pull the whole import pipeline into the poller).
 */
const LINK_WATCH_SOURCE = 'html-download';

/**
 * The servers a LINK-driven pull may read from: `null` when the pull is not
 * link-driven, `'not-its-queue'` when it must not run at all. A deep link's
 * watch re-reads the manifest long after the user confirmed the link: every
 * fetch then stays on the servers that confirmation showed — the manifest's
 * own and the queue's, which sits beside the confirmed archive — and a
 * redirect may not take it anywhere worse (`assertNoRedirectEscape`), as for
 * the import itself.
 *
 * Watch keys are not scoped to a queue, and a poller reports any key it is
 * merely SHOWN as done: another link's anonymous poller can report this
 * watch. Read from the CALLER, the allowlist would then name that other
 * server and the pull would apply its OCR to this watch's volume. So ANY
 * watch — a link's, an upload's — reported by a queue but its own is refused
 * (`'not-its-queue'`; the watch stays, and its own poller, which
 * watchServerOcr and startup always create, pulls it). On its own queue a
 * link's watch allows only the WATCH's origins. Without a watch, the
 * anonymous poller (which exists because a link was confirmed) stays on its
 * own server. A watch that is not a link's — the bunko account's uploads,
 * also when they landed on an anonymous poller a link created first (pollers
 * are keyed by queue URL alone) — reads its own queue as it always has.
 */
function linkPullOrigins(
  watched: WatchEntry | undefined,
  target: Pick<PullTarget, 'queueUrl' | 'auth'>
): readonly string[] | 'not-its-queue' | null {
  if (watched && watched.queue_url !== target.queueUrl) return 'not-its-queue';
  if (watched?.source === LINK_WATCH_SOURCE) {
    return [watched.manifest_url, watched.queue_url].filter((u) => !!u);
  }
  if (!watched && (target.auth ?? 'none') === 'none') return [target.queueUrl];
  return null;
}

/** Is `url` http(s) on the origin of one of `allowedUrls`? */
function onOriginOf(url: string, allowedUrls: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return allowedUrls.some((allowed) => originOf(allowed) === parsed.origin);
  } catch {
    return false;
  }
}

/** `fetchWithQueueAuth`, refusing (throwing) a link-driven response a redirect took somewhere worse. */
async function fetchForPull(
  url: string,
  init: RequestInit,
  target: Pick<PullTarget, 'queueUrl' | 'auth'>,
  linkDriven: boolean
): Promise<Response> {
  const response = await fetchWithQueueAuth(url, init, target.queueUrl, target.auth);
  if (linkDriven) assertNoRedirectEscape(url, response);
  return response;
}

async function fetchBlob(
  url: string,
  init: RequestInit,
  what: string,
  target: Pick<PullTarget, 'queueUrl' | 'auth'>,
  linkDriven: boolean
): Promise<Blob | null> {
  try {
    const response = await fetchForPull(url, init, target, linkDriven);
    if (response.ok) return await response.blob();
    console.warn(`[OCR queue] Could not fetch ${what} ${url}: HTTP ${response.status}`);
  } catch (error) {
    console.warn(`[OCR queue] Could not fetch ${what} ${url}:`, error);
  }
  return null;
}

/** Only an image-only installed volume, never hand-edited, takes the server's primary. */
function wantsPrimary(row: VolumeMetadata): boolean {
  if (!isVolumeInstalled(row)) return false;
  const version = typeof row.mokuro_version === 'string' ? row.mokuro_version.trim() : '';
  return version === '' && !row.ocr_edited_at;
}

async function localRowFor(
  key: string,
  series: string,
  volume: string
): Promise<VolumeMetadata | undefined> {
  const watched = loadWatches().get(key);
  if (watched) {
    const row = await db.volumes.get(watched.volume_uuid);
    if (row && !row.isPlaceholder) return row;
  }
  const titleKey = normalizeVolumeTitleKey(volume);
  const rows = await volumesForFoldedSeriesTitle(series, normalizeSeriesKey);
  return rows.find((r) => !r.isPlaceholder && normalizeVolumeTitleKey(r.volume_title) === titleKey);
}

async function pullManifestFiles(
  row: VolumeMetadata,
  manifest: VolumeManifest,
  target: PullTarget,
  source: string,
  linkDriven: boolean
): Promise<void> {
  const init = target.init;
  if (manifest.ocr && wantsPrimary(row)) {
    const blob = await fetchBlob(manifest.ocr.url, init, 'OCR file', target, linkDriven);
    if (blob) {
      const { upgradeOcrFromSidecarBlob } = await import('$lib/catalog/cloud-ocr-upgrade');
      try {
        await upgradeOcrFromSidecarBlob(row.volume_uuid, manifest.ocr.url, blob);
      } catch (error) {
        console.warn(`[OCR queue] Could not apply OCR file ${manifest.ocr.url}:`, error);
      }
    }
  }
  const fetched: FetchedLayerFile[] = [];
  for (const layer of manifest.layers) {
    if (await getLayerMeta(db, row.volume_uuid, layer.id)) continue;
    const blob = await fetchBlob(layer.url, init, `OCR layer '${layer.id}'`, target, linkDriven);
    if (!blob) continue;
    fetched.push({
      layerId: layer.id,
      gz: layer.gz,
      blob,
      label: layer.url,
      ...(layer.size !== undefined ? { size: layer.size } : {}),
      ...(layer.modified !== undefined ? { modifiedTime: layer.modified } : {})
    });
  }
  if (fetched.length === 0) return;
  const { importFetchedLayers } = await import('$lib/metadata/layer-sync');
  await importFetchedLayers(row.volume_uuid, source, fetched);
}

const pulling = new Map<string, Promise<boolean | PendingOnServer>>();

/**
 * Pull a finished volume's new sidecars through its manifest. At most one pull
 * per volume in flight (a second call gets the same promise). True when the
 * manifest was read and applied; the volume's watch then ends. When the
 * manifest still lists jobs the volume is not finished — it is only past the
 * queue file's hundred — so nothing is pulled, the watch stays, and the jobs
 * come back to be shown. Never rejects.
 */
export function pullCompletedVolume(
  key: string,
  entry: Pick<QueueVolume, 'series' | 'volume' | 'manifest'> | undefined,
  target: PullTarget
): Promise<boolean | PendingOnServer> {
  // Decided before the in-flight check, synchronously: a refusal must
  // neither join nor occupy the slot the watch's own queue pulls through.
  const allowed = linkPullOrigins(loadWatches().get(key), target);
  if (allowed === 'not-its-queue') {
    console.warn(`[OCR queue] Not pulling ${key} for ${target.queueUrl}: its link watched another`);
    return Promise.resolve(false);
  }
  const inFlight = pulling.get(key);
  if (inFlight) return inFlight;
  let finished = false;
  const run = (async () => {
    try {
      const watched = loadWatches().get(key);
      const series = entry?.series ?? watched?.series;
      const volume = entry?.volume ?? watched?.volume;
      if (!series || !volume) return false;
      const row = await localRowFor(key, series, volume);
      if (!row) {
        if (watched) dropWatch(key); // the volume is gone: nothing left to watch
        return false;
      }
      const manifestUrl = entry?.manifest
        ? resolveBunkoLink(entry.manifest, target.queueUrl)
        : watched?.manifest_url;
      if (!manifestUrl) return false;
      if (allowed && !onOriginOf(manifestUrl, allowed)) {
        console.warn(
          `[OCR queue] Not reading manifest ${manifestUrl}: it is not on a server the link named`
        );
        return false;
      }
      const fetched = await loadVolumeManifest(
        manifestUrl,
        target.init.headers as Record<string, string> | undefined,
        (input, init) => fetchForPull(String(input), init ?? {}, target, allowed !== null)
      );
      const load =
        allowed && 'manifest' in fetched
          ? confineManifestToOrigins(fetched.manifest, allowed)
          : fetched;
      if ('error' in load) {
        console.warn(`[OCR queue] Manifest ${manifestUrl} unavailable:`, load.error);
        return false;
      }
      if (load.manifest.pending.length > 0) {
        return {
          series,
          volume,
          pending: load.manifest.pending,
          recheckAfter: load.manifest.recheck_after
        };
      }
      await pullManifestFiles(
        row,
        load.manifest,
        target,
        watched?.source ?? target.source,
        allowed !== null
      );
      dropWatch(key);
      return true;
    } catch (error) {
      console.warn('[OCR queue] Pull failed; it is retried on the next look:', error);
      return false;
    } finally {
      finished = true;
      pulling.delete(key);
    }
  })();
  // A body that returns before its first await has already run its `finally`
  // here: registering it now would leave a settled promise answering every
  // later pull of the key.
  if (!finished) pulling.set(key, run);
  return run;
}

// ---------------------------------------------------------------- pollers per server

const pollers = new Map<string, QueuePoller>();

/**
 * The provider manager, imported lazily (it pulls in every provider) through
 * ONE promise: every caller gets the same module, also when several ask at
 * once (vitest 3 hands the second of two concurrent imports of a mocked
 * module the unmocked one).
 */
let providerManagerImport: Promise<typeof import('$lib/util/sync/provider-manager')> | null = null;
function providerManagerModule(): Promise<typeof import('$lib/util/sync/provider-manager')> {
  return (providerManagerImport ??= import('$lib/util/sync/provider-manager'));
}
/** The SERVER pollers that read as the connected WebDAV account (`auth: 'webdav'`). */
const webdavAuthPollers = new Set<string>();

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

async function activeWebdavProvider(): Promise<{
  type?: string;
  getWorkerUploadCredentials?: () => Promise<Record<string, unknown>>;
} | null> {
  const { providerManager } = await providerManagerModule();
  const provider = providerManager.getActiveProvider() as {
    type?: string;
    getWorkerUploadCredentials?: () => Promise<Record<string, unknown>>;
  } | null;
  return provider?.type === 'webdav' && provider.getWorkerUploadCredentials ? provider : null;
}

async function requestInitFor(
  queueUrl: string,
  auth: WatchEntry['auth']
): Promise<RequestInit | null> {
  if (auth === 'none') return { cache: 'no-store' };
  const provider = await activeWebdavProvider();
  if (!provider) return null;
  const credentials = await provider.getWorkerUploadCredentials!();
  const url = typeof credentials.webdavUrl === 'string' ? credentials.webdavUrl : '';
  // A queue on another origin than the connected account's (an account since
  // switched away from): its credentials never leave for it, and an
  // anonymous read of an account's queue would only be refused, again at
  // every look. Nothing to read until that account is connected again.
  if (originOf(url) === null || originOf(url) !== originOf(queueUrl)) return null;
  // The session's header: Bearer when a token is held, else Basic, else none.
  const authorization = webdavAuthorization(authFromCredentials(credentials));
  if (!authorization) return { cache: 'no-store' };
  return { cache: 'no-store', headers: { Authorization: authorization } };
}

function pollerFor(queueUrl: string, auth: WatchEntry['auth'], source: string): QueuePoller {
  const existing = pollers.get(queueUrl);
  if (existing) return existing;
  const poller = new QueuePoller({
    queueUrl,
    requestInit: () => requestInitFor(queueUrl, auth),
    watchedKeys: () =>
      watchedEntries()
        .filter((w) => w.queue_url === queueUrl)
        .map((w) => w.key),
    isShown: (key) => isVolumeShown(key),
    onStatus: (file) => publishQueueStatus(queueUrl, file),
    onDone: async (key, entry) => {
      const init = await requestInitFor(queueUrl, auth);
      return init ? pullCompletedVolume(key, entry, { queueUrl, init, source, auth }) : false;
    },
    isHidden,
    // An anonymous poller is made for a link's watch (or restored for one),
    // though an upload watch on the same server may share it later: its queue
    // file is read under the same redirect rule as the link's other fetches.
    fetch: (input, init) =>
      fetchForPull(String(input), init ?? {}, { queueUrl, auth }, auth === 'none')
  });
  pollers.set(queueUrl, poller);
  if (auth === 'webdav') webdavAuthPollers.add(queueUrl);
  return poller;
}

/** The queue file of a WebDAV root: `<server>/mokuro-reader/.mokuro-queue.json`. */
export function queueUrlForWebdav(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/mokuro-reader/.mokuro-queue.json`;
}

/**
 * The queue file beside a deep-linked archive: the DAV root is the archive's
 * path minus `<series>/<file>` (`/mokuro-reader/S/V.cbz` → `/mokuro-reader`).
 */
export function queueUrlForArchive(archiveUrl: string): string | null {
  try {
    const url = new URL(archiveUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 3) return null;
    return `${url.origin}/${parts.slice(0, -2).join('/')}/.mokuro-queue.json`;
  } catch {
    return null;
  }
}

/**
 * The connected WebDAV account's queue, when it is a bunko server: it answered
 * `X-Mokuro-Put: verified`, or its identity says it compiles the metadata
 * (`/login/api/me`) — not merely a fresh cloud-direct marker on plain storage.
 */
export async function connectedBunkoQueueUrl(): Promise<string | null> {
  try {
    const provider = await activeWebdavProvider();
    if (!provider) return null;
    const credentials = await provider.getWorkerUploadCredentials!();
    if (typeof credentials.webdavUrl !== 'string' || !credentials.webdavUrl) return null;
    if (credentials.webdavPutVerified === true) return queueUrlForWebdav(credentials.webdavUrl);
    const status = (provider as Partial<SyncProvider>).getStatus?.();
    if (status?.serverCompilesMetadata === true && status.cloudBunko?.fresh !== true) {
      return queueUrlForWebdav(credentials.webdavUrl);
    }
    return null;
  } catch {
    return null;
  }
}

let started = false;

/**
 * A card started showing a volume: an idle poller takes one look, at most once
 * a minute (batched over a burst of cards mounting), so a volume pending on the
 * server shows its status without waiting for the next app start.
 */
let shownNudge: ReturnType<typeof setTimeout> | null = null;
export function nudgeForShownVolumes(): void {
  if (!started || shownNudge) return;
  shownNudge = setTimeout(() => {
    shownNudge = null;
    for (const p of pollers.values()) {
      if (p.state === 'idle' && Date.now() - p.lastPollAt >= 60_000) p.trigger('shown');
    }
  }, 500);
}

/**
 * App start (after providers connect): drop the old recheck entries, plan the
 * watched volumes' reads (`watchSchedule`: their series files, at creation
 * + 2 W and then by their ETAs), start the connected cloud library's marker
 * poll, and follow the tab's visibility. No queue file is read here: a series
 * page reads its own series file (`followSeriesQueue`), and only a server
 * older than queue file v2 falls back to its root file's poller.
 */
export async function startServerOcrQueue(): Promise<void> {
  if (started) return;
  started = true;
  cleanupLegacyRecheckEntries();
  setShownListener(nudgeForShownVolumes);
  connectedServer = await connectedBunkoQueueUrl();
  watchSchedule().kick();
  // The connected cloud library's marker (and again after every login,
  // switch or logout): created — and given its first look — there.
  await followActiveProvider();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (isHidden()) flushWatches();
      for (const p of pollers.values()) p.onVisibilityChange();
      markerPoller?.onVisibilityChange();
      schedule?.onVisibilityChange();
    });
  }
  globalThis.addEventListener?.('pagehide', flushWatches);
}

// ---------------------------------------------------------------- cloud-direct Bunko

/**
 * Floors between reads of a cloud library's control files. A Bunko writes a
 * series file at most once per batch window (Drive and OneDrive 120 s, MEGA
 * 300 s, WebDAV 30 s, a Local Folder 15 s — the marker's `batch_s`), and the
 * series page never reads faster than the larger of the two. MEGA's reads are
 * answered from the live in-memory tree and re-triggered by its change events,
 * so its floor costs no requests.
 */
export const CLOUD_MIN_INTERVAL_S: Record<ProviderType, number> = {
  webdav: 30,
  'google-drive': 60,
  onedrive: 60,
  mega: 60,
  // Local reads cost no requests; Bunko batches a folder library's writes
  // every 15 s (queue file v2, §6.4).
  filesystem: 15
};

async function activeProvider(): Promise<SyncProvider | null> {
  const { providerManager } = await providerManagerModule();
  return providerManager.getActiveProvider();
}

/**
 * The connected provider when its library may be run by a cloud-direct Bunko
 * (it reads control files, and it is not a bunko SERVER, which serves its
 * queue itself): Drive, OneDrive, MEGA, a Local Folder or plain WebDAV. Null
 * otherwise.
 */
export async function connectedCloudLibrary(): Promise<ProviderType | null> {
  try {
    const provider = await activeProvider();
    if (!provider?.readControlFile) return null;
    if (provider.type === 'webdav' && (await connectedBunkoQueueUrl())) return null;
    return provider.type;
  } catch {
    return null;
  }
}

/**
 * The lease marker of the connected cloud library, read every `max(provider
 * floor, ttl/3)` (300 s for Bunko's 900 s lease) while the tab is visible.
 * It keeps `serverCompilesMetadata`, the holder's freshness and the queue's
 * work clock current; MEGA's live tree also pushes its changes. This replaces
 * the 60 s loop that read a root queue file (queue file v2: none is written).
 * A failed read backs off as the queue poller does; the last verdict stands
 * meanwhile, ageing towards stale.
 */
export class MarkerPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fetching = false;
  private again = false;
  private paused = false;
  private stopped = false;
  private errors = 0;
  private delay: number | null = null;

  constructor(
    readonly providerType: ProviderType,
    private readonly deps: {
      provider: () => Promise<SyncProvider | null>;
      isHidden: () => boolean;
    } = { provider: activeProvider, isHidden }
  ) {}

  get id(): string {
    return `cloud:${this.providerType}`;
  }

  /** The wait before the next scheduled read, or null when none is scheduled. */
  get nextDelayMs(): number | null {
    return this.timer ? this.delay : null;
  }

  trigger(): void {
    if (this.stopped) return;
    if (this.deps.isHidden()) {
      this.clearTimer();
      this.paused = true;
      return;
    }
    if (this.fetching) {
      this.again = true;
      return;
    }
    this.clearTimer();
    void this.read();
  }

  onVisibilityChange(): void {
    if (this.stopped) return;
    if (this.deps.isHidden()) {
      if (this.timer || this.fetching) this.paused = true;
      this.clearTimer();
      return;
    }
    const wasPaused = this.paused;
    this.paused = false;
    if (wasPaused || !this.fetching) this.trigger();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.delay = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.delay = ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.delay = null;
      void this.read();
    }, ms);
  }

  private async read(): Promise<void> {
    if (this.deps.isHidden()) {
      this.paused = true;
      return;
    }
    this.fetching = true;
    try {
      const provider = await this.deps.provider();
      if (!provider || provider.type !== this.providerType || !provider.readControlFile) {
        this.stop();
        return;
      }
      const { refreshCloudBunkoMarker, cloudBunkoHolder } = await import('./cloud-bunko-marker');
      if (!(await refreshCloudBunkoMarker(provider))) {
        const wait = QUEUE_BACKOFF_MS[Math.min(this.errors, QUEUE_BACKOFF_MS.length - 1)];
        this.errors++;
        console.warn(
          `[OCR queue] the Bunko marker could not be read; next look in ${wait / 1000} s`
        );
        if (!this.stopped) this.schedule(wait);
        return;
      }
      this.errors = 0;
      const ttl = cloudBunkoHolder(this.providerType)?.ttl_s ?? MARKER_DEFAULT_TTL_S;
      const floor = CLOUD_MIN_INTERVAL_S[this.providerType] ?? 60;
      if (!this.stopped) this.schedule(Math.max(floor, ttl / 3) * 1000);
    } finally {
      this.fetching = false;
      if (this.again && !this.stopped) {
        this.again = false;
        this.clearTimer();
        void this.read();
      }
    }
  }
}

/** Bunko's lease TTL when no holder names one: a marker read every 300 s. */
const MARKER_DEFAULT_TTL_S = 900;

let markerPoller: MarkerPoller | null = null;
let markerFeedOff: (() => void) | null = null;

/**
 * The marker poll of the connected cloud library, created (and given its
 * first look) when the provider can read control files; one for a provider
 * no longer connected is stopped. MEGA's live tree pushes changes
 * (`onControlFileChange`): a root control-file event triggers a look.
 */
export async function ensureMarkerPoller(): Promise<MarkerPoller | null> {
  const type = await connectedCloudLibrary();
  if (markerPoller && markerPoller.providerType !== type) {
    markerPoller.stop();
    markerPoller = null;
    markerFeedOff?.();
    markerFeedOff = null;
  }
  if (!type) return null;
  if (markerPoller) return markerPoller;
  const poller = new MarkerPoller(type);
  markerPoller = poller;
  const provider = await activeProvider();
  // Root control files only: a series folder's file is its page's business.
  markerFeedOff =
    provider?.onControlFileChange?.((_name, folder) => {
      if (folder === undefined) poller.trigger();
    }) ?? null;
  poller.trigger();
  return poller;
}

// ---------------------------------------------------------------- series pages (queue file v2)

/** Bunko servers that answered 404 for a series they hold: older than v2, read by their v1 poller. */
const v1Servers = new Set<string>();

// ---------------------------------------------------------------- the scoped pull (§8.6)

/** A burst of completions in one series settles this long before its pull. */
export const SERIES_PULL_DEBOUNCE_MS = 10_000;
/** Two pulls of one series are at least this far apart. */
export const SERIES_PULL_SPACING_MS = 60_000;
/** A pull that found nothing new is tried again after these waits, then left to the next listing. */
export const SERIES_PULL_RETRY_MS: readonly number[] = [60_000, 120_000, 240_000];

type CloudManager = (typeof import('$lib/util/sync/unified-cloud-manager'))['unifiedCloudManager'];
type SeriesFolderRefresh = NonNullable<Awaited<ReturnType<CloudManager['refreshSeriesFolder']>>>;

interface PullStem {
  stem: string;
  /** End the volume's watch once pulled (its file said it is done). */
  drop: boolean;
}

interface PullSlot {
  providerType: ProviderType;
  folder: string;
  stems: Map<string, PullStem>;
  waiters: Array<(result: SeriesFolderRefresh | null) => void>;
  timer: ReturnType<typeof setTimeout> | null;
  timerAt: number;
  running: boolean;
  lastRunAt: number;
  /** Retries taken of a pull that found nothing new. */
  attempt: number;
}

/** Is `name` (a basename) the primary sidecar or a layer of `stemKey`'s volume? */
function isSidecarOf(name: string, stemKey: string): boolean {
  const folded = normalizeVolumeTitleKey(name);
  return folded.startsWith(`${stemKey}.`) && /\.mokuro(\.gz)?$/.test(folded);
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Did the pull bring anything new: the `series.json` stamp, or a sidecar of a finished volume? */
function pullMoved(result: SeriesFolderRefresh, stems: readonly PullStem[]): boolean {
  const keys = stems.map((s) => normalizeVolumeTitleKey(s.stem));
  return result.changed.some((path) => {
    const name = basenameOf(path);
    if (name.toLowerCase() === 'series.json') return true;
    return keys.some((key) => isSidecarOf(name, key));
  });
}

/**
 * The scoped pull of a series whose OCR finished (queue file v2, §8.6),
 * replacing the whole-account relist of a cloud and the manifest pull of the
 * connected Bunko server:
 *
 * 1. `unifiedCloudManager.refreshSeriesFolder` lists that one series (the
 *    Drive change feed when it is usable) and refreshes its `series.json`;
 * 2. the OCR upgrade pass runs for the series, with the folder's files — the
 *    primary sidecar arrives through `series.json`'s `mokuro_sha256`;
 * 3. the layers of every local row of a finished volume are pulled.
 *
 * Per series: debounced {@link SERIES_PULL_DEBOUNCE_MS}, at least
 * {@link SERIES_PULL_SPACING_MS} apart, one in flight. A pull that moved
 * neither the `series.json` stamp nor a sidecar of a finished volume is tried
 * again after {@link SERIES_PULL_RETRY_MS}, then left to the next listing
 * (Bunko's settle rule makes that rare).
 */
class SeriesPulls {
  private slots = new Map<string, PullSlot>();
  /** The runs in flight, for tests to wait out. */
  private runs = new Set<Promise<void>>();

  /** Pull `folder` for these finished stems; resolves with the refresh once it ran (null: nothing listed). */
  request(
    providerType: ProviderType,
    folder: string,
    stems: string[],
    opts: { drop: boolean }
  ): Promise<SeriesFolderRefresh | null> {
    const id = `${providerType}\u0000${normalizeSeriesKey(folder)}`;
    let slot = this.slots.get(id);
    if (!slot) {
      slot = {
        providerType,
        folder,
        stems: new Map(),
        waiters: [],
        timer: null,
        timerAt: Infinity,
        running: false,
        lastRunAt: -Infinity,
        attempt: 0
      };
      this.slots.set(id, slot);
    }
    slot.folder = folder;
    for (const stem of stems) {
      const key = normalizeVolumeTitleKey(stem);
      const held = slot.stems.get(key);
      slot.stems.set(key, { stem, drop: opts.drop || !!held?.drop });
    }
    slot.attempt = 0;
    const done = new Promise<SeriesFolderRefresh | null>((resolve) => slot.waiters.push(resolve));
    this.arm(slot, SERIES_PULL_DEBOUNCE_MS);
    return done;
  }

  private arm(slot: PullSlot, delayMs: number): void {
    if (slot.running) return; // the run re-arms when it ends
    const now = Date.now();
    const at = Math.max(now + delayMs, slot.lastRunAt + SERIES_PULL_SPACING_MS);
    if (slot.timer && slot.timerAt <= at) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timerAt = at;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      slot.timerAt = Infinity;
      const run = this.run(slot);
      this.runs.add(run);
      void run.finally(() => this.runs.delete(run));
    }, at - now);
  }

  /** Tests: wait for the pulls in flight (a pull due later waits on its timer). */
  async settle(): Promise<void> {
    while (this.runs.size > 0) await Promise.all([...this.runs]);
  }

  private async run(slot: PullSlot): Promise<void> {
    const batch = [...slot.stems.values()];
    const waiters = slot.waiters;
    slot.stems.clear();
    slot.waiters = [];
    slot.running = true;
    slot.lastRunAt = Date.now();
    let result: SeriesFolderRefresh | null = null;
    try {
      result = await pullSeries(slot.providerType, slot.folder, batch);
    } catch (error) {
      console.warn(`[OCR queue] The pull of '${slot.folder}' failed; it is tried again:`, error);
    } finally {
      slot.running = false;
    }
    for (const resolve of waiters) resolve(result);
    if (slot.stems.size > 0) {
      this.arm(slot, SERIES_PULL_DEBOUNCE_MS);
      return;
    }
    if (result && pullMoved(result, batch)) return;
    if (slot.attempt >= SERIES_PULL_RETRY_MS.length) return; // the next listing has it
    const wait = SERIES_PULL_RETRY_MS[slot.attempt++];
    for (const b of batch) slot.stems.set(normalizeVolumeTitleKey(b.stem), { ...b, drop: false });
    this.arm(slot, wait);
  }

  /** Tests: how many series have a pull armed or running. */
  pending(): number {
    let n = 0;
    for (const slot of this.slots.values()) if (slot.timer || slot.running) n++;
    return n;
  }

  reset(): void {
    for (const slot of this.slots.values()) if (slot.timer) clearTimeout(slot.timer);
    this.slots.clear();
  }
}

/** One scoped pull (see {@link SeriesPulls}). */
async function pullSeries(
  providerType: ProviderType,
  folder: string,
  batch: readonly PullStem[]
): Promise<SeriesFolderRefresh | null> {
  const provider = await activeProvider();
  if (!provider || provider.type !== providerType) return null;
  const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
  const result = await unifiedCloudManager.refreshSeriesFolder(folder);
  if (!result) return null;
  try {
    const { requestOcrUpgradePass } = await import('./ocr-upgrade-pass');
    // The folder's own files: a pass reads one level, as the listing's does.
    const files = result.files.filter((f) => f.path.split('/').filter(Boolean).length === 2);
    void requestOcrUpgradePass(result.providerType, [{ title: result.folder, files }]);
  } catch (error) {
    console.debug('[OCR queue] Could not request the OCR upgrade pass:', error);
  }
  const { pullLayersForVolume } = await import('$lib/metadata/layer-sync');
  for (const { stem, drop } of batch) {
    const key = volumeQueueKey(result.folder, stem);
    try {
      const row = await localRowFor(key, result.folder, stem);
      if (row) await pullLayersForVolume(row.volume_uuid, result.providerType);
    } catch (error) {
      console.debug('[OCR queue] Could not pull layers of a finished volume:', error);
    }
    if (drop) dropWatch(key);
  }
  return result;
}

const seriesPulls = new SeriesPulls();

/** Tests: how many series pulls are armed or running. */
export function pendingSeriesPullsForTest(): number {
  return seriesPulls.pending();
}

/** Tests: wait for the series pulls in flight. */
export function settleSeriesPullsForTest(): Promise<void> {
  return seriesPulls.settle();
}

/**
 * Volumes of `folder` whose OCR a series file says finished: the scoped pull
 * of that series, on a cloud library and on the connected Bunko server alike
 * (no manifest: the sidecars are in the listing, `series.json` names the new
 * primary). Their watches end once it ran.
 */
function completeSeriesVolumes(c: {
  provider: SyncProvider;
  folder: string;
  stems: string[];
}): void {
  void seriesPulls.request(c.provider.type, c.folder, c.stems, { drop: true });
}

/** The app's side of the series page loop. */
function seriesQueueEnv(manager: CloudManager): SeriesQueueEnv {
  return {
    provider: activeProvider,
    async scopeOf(provider) {
      if (provider.type !== 'webdav') return provider.type;
      const credentials = (await (
        provider as { getWorkerUploadCredentials?: () => Promise<Record<string, unknown>> }
      ).getWorkerUploadCredentials?.()) as Record<string, unknown> | undefined;
      const url = typeof credentials?.webdavUrl === 'string' ? credentials.webdavUrl : '';
      return `webdav ${url}`;
    },
    async bunkoServer(provider) {
      return provider.type === 'webdav' ? connectedBunkoQueueUrl() : null;
    },
    isV1Server: (queueUrl) => v1Servers.has(queueUrl),
    fallBackToV1(queueUrl, firstTime) {
      v1Servers.add(queueUrl);
      const poller = pollerFor(queueUrl, 'webdav', 'webdav');
      // The cards already registered as shown: one look now; later pages
      // nudge it through `nudgeForShownVolumes`.
      if (firstTime || poller.state === 'idle') poller.trigger('shown');
    },
    folderFor: (title) => manager.resolveCloudFolderTitle(title),
    folderListed: (folder) => manager.getCloudVolumesBySeries(folder).length > 0,
    holder: (scope) => cloudBunkoHolder(scope),
    refreshMarker: (provider) => refreshCloudBunkoMarker(provider),
    watchedKeys: () => watchedEntries().map((w) => w.key),
    floorS: (type) => CLOUD_MIN_INTERVAL_S[type as ProviderType] ?? 60,
    onCompleted: (c) => completeSeriesVolumes(c),
    isHidden,
    now: () => Date.now()
  };
}

let defaultSeriesQueueEnv: Promise<SeriesQueueEnv> | null = null;

/** The app's env of the series loop; the folder lookups need the manager (every provider), loaded once, lazily. */
function seriesEnv(): Promise<SeriesQueueEnv> {
  return (defaultSeriesQueueEnv ??= import('$lib/util/sync/unified-cloud-manager').then((m) =>
    seriesQueueEnv(m.unifiedCloudManager)
  ));
}

/**
 * Follow the OCR queue of the series page for `seriesTitle` while it is
 * mounted (`SeriesView`); returns the stop. The only place the reader reads
 * queue state for a library it is connected to.
 */
export async function followSeriesQueue(
  seriesTitle: string,
  env?: SeriesQueueEnv
): Promise<() => void> {
  env ??= await seriesEnv();
  const stop = followSeriesQueueLoop(seriesTitle, env);
  return () => {
    stop();
    // Its watched volumes go back on their own schedule.
    schedule?.kick();
  };
}

// ---------------------------------------------------------------- watched volumes off their page (§8.7)

let schedule: WatchSchedule | null = null;

/** The schedule that reads watched volumes' series files (`series-queue-watch.ts`). */
function watchSchedule(): WatchSchedule {
  return (schedule ??= new WatchSchedule({
    // A server known to be older than v2 polls its own watches (v1 root file).
    watches: () =>
      watchedEntries().filter((w) => w.auth === 'cloud' || !v1Servers.has(w.queue_url)),
    windowMs: (group) => watchWindowMs(group.watches[0], null),
    look: lookWatchedSeries,
    pullAbsent: pullAbsentWatch,
    complete: completeWatch,
    isHidden,
    now: () => Date.now()
  }));
}

/** W for a watch: the larger of its provider's floor and the store's `batch_s`. */
function watchWindowMs(w: WatchEntry, block: SeriesQueueBlock | null): number {
  if (w.auth !== 'cloud') {
    return Math.max(CLOUD_MIN_INTERVAL_S.webdav, block?.batch_s ?? 0) * 1000;
  }
  const type = w.source as ProviderType;
  const batch = block?.batch_s ?? cloudBunkoHolder(type)?.series_queue?.batch_s ?? 0;
  return Math.max(CLOUD_MIN_INTERVAL_S[type] ?? 60, batch) * 1000;
}

/** A queue status's soonest ETA, epoch ms; null when none of its jobs has one. */
function soonestEtaMs(jobs: readonly QueueJob[]): number | null {
  let soonest: number | null = null;
  for (const job of jobs) {
    const at = job.eta ? Date.parse(job.eta) : NaN;
    if (Number.isFinite(at) && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}

/** What a series file shows for the watched volumes of `group`. */
function watchLookOf(
  group: WatchGroup,
  file: SeriesQueueFile,
  block: SeriesQueueBlock | null,
  windowMs: number
): WatchLook {
  const slice = seriesQueueSlice(file, block);
  const done = new Set([...file.done.keys()].map(normalizeVolumeTitleKey));
  const look = {
    kind: 'read' as const,
    windowMs,
    present: new Map<string, number | null>(),
    done: new Set<string>()
  };
  for (const w of group.watches) {
    const stem = normalizeVolumeTitleKey(w.volume);
    const status = slice.get(stem);
    if (status) look.present.set(w.key, soonestEtaMs(status.jobs));
    else if (done.has(stem)) look.done.add(w.key);
  }
  return look;
}

/**
 * One read for watched volumes: through the connected library (the series
 * page's own path, memo and completions) for an upload watch, through the
 * link's origin for a deep link's.
 */
async function lookWatchedSeries(group: WatchGroup): Promise<WatchLook> {
  const w = group.watches[0];
  if (w.auth === 'none') return lookLinkSeries(group);
  const provider = await activeProvider();
  if (!provider?.readControlFile) return { kind: 'wait' };
  if (w.auth === 'cloud') {
    // Its library is not the one connected now: nothing to read it with.
    if (provider.type !== w.source || (await connectedCloudLibrary()) !== provider.type) {
      return { kind: 'wait' };
    }
  } else if ((await connectedBunkoQueueUrl()) !== w.queue_url) {
    return { kind: 'wait' };
  }
  // Its page is open: the page's loop reads it, and its last read is this
  // look too (no read of its own) — so a watched volume the file never lists
  // still gets its one scoped pull while the page stays open.
  const follower = seriesQueueFollower(w.series);
  if (follower) {
    const last = follower.lastLook;
    if (!last?.file) return { kind: 'wait', retryMs: watchWindowMs(w, null) };
    return watchLookOf(group, last.file, last.block, watchWindowMs(w, last.block));
  }
  const look = await lookSeriesQueue(w.series, await seriesEnv());
  if (look.kind === 'v1') return { kind: 'handed-off' };
  if (look.kind === 'none' || !look.file) return { kind: 'wait' };
  return watchLookOf(group, look.file, look.block, watchWindowMs(w, look.block));
}

/** A link's series file over HTTP, by group: its tag, its file, when it was read. */
const linkMemos = new Map<string, { etag: string | null; file: SeriesQueueFile | null }>();

/** The series file beside a queue's root file: `<dav root>/<series>/.mokuro-series-queue.json`. */
export function seriesQueueUrlFor(queueUrl: string, series: string): string | null {
  const root = '/.mokuro-queue.json';
  if (!queueUrl.endsWith(root) || !series) return null;
  return `${queueUrl.slice(0, -root.length)}/${encodeURIComponent(series)}/${SERIES_QUEUE_FILE_NAME}`;
}

/** The cards' status of a link's watched volumes, by group (`publishQueueStatus` ids). */
const linkStatusIds = new Set<string>();

/**
 * A deep link's watch: the series file is read through the link's origin,
 * anonymously and under the link's redirect rule, like every other fetch of
 * that link. A 404 means a Bunko older than v2: its root-file poller takes
 * over. Its watched volumes' jobs are shown on their cards.
 */
async function lookLinkSeries(group: WatchGroup): Promise<WatchLook> {
  const w = group.watches[0];
  const url = seriesQueueUrlFor(w.queue_url, w.series);
  if (!url) return { kind: 'handed-off' };
  const memo = linkMemos.get(group.id) ?? { etag: null, file: null };
  const init = (await requestInitFor(w.queue_url, 'none')) ?? { cache: 'no-store' as const };
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string> | undefined) ?? {})
  };
  if (memo.etag && memo.file) headers['If-None-Match'] = memo.etag;
  const response = await fetchForPull(
    url,
    { ...init, headers },
    { queueUrl: w.queue_url, auth: 'none' },
    true
  );
  if (response.status === 404) {
    linkMemos.delete(group.id);
    v1Servers.add(w.queue_url);
    pollerFor(w.queue_url, w.auth, w.source).trigger('deep-link');
    return { kind: 'handed-off' };
  }
  let file = memo.file;
  if (response.status !== 304 || !file) {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseSeriesQueueFile(await response.json());
    // Bunko's own virtual file carries `live`: a file without it is no Bunko's word.
    file = parsed ? pickTrustedCopy([parsed], { kind: 'live' }) : null;
    if (!file) throw new Error('not a series queue file (v2) of a Bunko server');
    memo.etag = response.headers.get('ETag');
  }
  memo.file = file;
  linkMemos.set(group.id, memo);
  const look = watchLookOf(group, file, file.live, watchWindowMs(w, file.live));
  publishLinkStatus(group, file);
  return look;
}

function publishLinkStatus(group: WatchGroup, file: SeriesQueueFile): void {
  const slice = seriesQueueSlice(file, file.live);
  const volumes: QueueVolume[] = [];
  for (const w of group.watches) {
    const status = slice.get(normalizeVolumeTitleKey(w.volume));
    if (status) {
      volumes.push({
        series: w.series,
        volume: w.volume,
        path: '',
        manifest: '',
        jobs: status.jobs
      });
    }
  }
  const id = `series:${group.id}`;
  linkStatusIds.add(id);
  publishQueueStatus(id, {
    version: 1,
    generated_at: '',
    held: file.live?.held ?? null,
    next_check_after: null,
    pending_volumes: null,
    volumes
  });
}

/** A watch ended: its card no longer shows what a link's series file said of it. */
function withdrawLinkStatus(key: string): void {
  let changed = false;
  for (const id of linkStatusIds) {
    const part = statusByQueue.get(id);
    if (part && key in part) {
      delete part[key];
      changed = true;
    }
  }
  if (changed) {
    const merged: Record<string, VolumeQueueStatus> = {};
    for (const part of statusByQueue.values()) Object.assign(merged, part);
    queueStatusStore.set(merged);
  }
}

function pullTargetFor(w: WatchEntry, init: RequestInit): PullTarget {
  return { queueUrl: w.queue_url, init, source: w.source, auth: w.auth };
}

/** Done or vanished: a link's watch pulls through its manifest (which ends it); any other just ends. */
function completeWatch(_group: WatchGroup, w: WatchEntry): void {
  if (w.auth !== 'none') {
    dropWatch(w.key);
    return;
  }
  void (async () => {
    const init = await requestInitFor(w.queue_url, 'none');
    if (!init) return;
    await pullCompletedVolume(
      w.key,
      { series: w.series, volume: w.volume, manifest: '' },
      pullTargetFor(w, init)
    );
  })();
}

/**
 * A watched volume its series file never listed, after 2 reads: one scoped
 * pull. A primary `.mokuro` listed newer than the watch completes it (a
 * link's: its manifest decides, as for any finished volume).
 */
async function pullAbsentWatch(_group: WatchGroup, w: WatchEntry): Promise<boolean> {
  if (w.auth === 'none') {
    const init = await requestInitFor(w.queue_url, 'none');
    if (!init) return false;
    const result = await pullCompletedVolume(
      w.key,
      { series: w.series, volume: w.volume, manifest: '' },
      pullTargetFor(w, init)
    );
    return result === true;
  }
  const provider = await activeProvider();
  if (!provider) return false;
  const result = await seriesPulls.request(provider.type, w.series, [w.volume], { drop: false });
  if (!result) return false;
  const stem = normalizeVolumeTitleKey(w.volume);
  const fresh = result.files.some((f) => {
    const name = normalizeVolumeTitleKey(basenameOf(f.path));
    if (name !== `${stem}.mokuro` && name !== `${stem}.mokuro.gz`) return false;
    const at = Date.parse(f.modifiedTime);
    return Number.isFinite(at) && at > w.added_at;
  });
  if (fresh) dropWatch(w.key);
  return fresh;
}

// ---------------------------------------------------------------- following the connected provider

let providerFollow: (() => void) | null = null;
/** The bunko server the pollers last followed (`ensureServerPoller`). */
let connectedServer: string | null = null;

/**
 * A server switched or logged away from: its poller would go on reading as
 * an account no longer connected. Stopped and its status withdrawn, unless
 * volumes are still watched there (those wait, reading nothing, until that
 * account is connected again — `requestInitFor`). The server connected now
 * gets no poller of its own (its series pages read their series files); one
 * kept for its watched volumes takes one look when it is connected again.
 */
async function ensureServerPoller(): Promise<void> {
  const connected = await connectedBunkoQueueUrl();
  for (const id of [...webdavAuthPollers]) {
    if (id === connected || watchedEntries().some((w) => w.queue_url === id)) continue;
    pollers.get(id)?.stop();
    pollers.delete(id);
    webdavAuthPollers.delete(id);
    publishQueueStatus(id, null);
  }
  const switched = connected !== connectedServer;
  connectedServer = connected;
  // Watches that waited for their account may be readable now.
  schedule?.wake();
  if (!connected || !switched) return;
  pollers.get(connected)?.trigger('start');
}

/** Log in / switch / log out after start: keep the pollers on the connected provider. */
async function followActiveProvider(): Promise<void> {
  if (providerFollow) return;
  const { providerManager } = await providerManagerModule();
  if (!providerManager.status) {
    await ensureMarkerPoller();
    return;
  }
  let lastType: string | null | undefined;
  const unsubscribe = providerManager.status.subscribe((status) => {
    const type = status.hasAnyAuthenticated ? status.currentProviderType : null;
    if (type === lastType) {
      // A switch from one WebDAV server to another keeps the type.
      if (type === 'webdav') void ensureMarkerPoller().then(ensureServerPoller);
      return;
    }
    lastType = type;
    // In turn: the marker poll steps aside for a bunko server (or, connected
    // elsewhere now, the last server's poller is dropped).
    void ensureMarkerPoller().then(ensureServerPoller);
  });
  providerFollow = unsubscribe;
}

/** Tests: forget every poller, watch and published status. */
export function resetServerOcrQueueForTest(): void {
  for (const p of pollers.values()) p.stop();
  pollers.clear();
  webdavAuthPollers.clear();
  connectedServer = null;
  pulling.clear();
  statusByQueue.clear();
  queueStatusStore.set({});
  resetSeriesQueueStoreForTest();
  watches = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  watchedKeyStore.set({});
  started = false;
  seriesPulls.reset();
  schedule?.stop();
  schedule = null;
  linkMemos.clear();
  linkStatusIds.clear();
  markerPoller?.stop();
  markerPoller = null;
  markerFeedOff?.();
  markerFeedOff = null;
  v1Servers.clear();
  defaultSeriesQueueEnv = null;
  resetSeriesQueueLoopForTest();
  providerFollow?.();
  providerFollow = null;
  setShownListener(null);
  if (shownNudge) clearTimeout(shownNudge);
  shownNudge = null;
}
