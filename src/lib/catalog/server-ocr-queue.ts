import { db } from '$lib/catalog/db';
import { getLayerMeta } from '$lib/catalog/layer-store';
import { volumesForFoldedSeriesTitle } from '$lib/catalog/volumes-by-series';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import {
  loadVolumeManifest,
  type ManifestPendingJob,
  type VolumeManifest
} from '$lib/import/deep-link-manifest';
import type { FetchedLayerFile } from '$lib/metadata/layer-sync';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import type { VolumeMetadata } from '$lib/types';
import { basicAuthHeader } from '$lib/util/base64';
import {
  isVolumeShown,
  queueStatusStore,
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
 * - Started by an upload or a deep-link import (at once), by app start and by
 *   the tab becoming visible (one poll); then every `next_check_after` s
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
  return {
    kind,
    id,
    state,
    eta: typeof eta === 'string' && Number.isFinite(Date.parse(eta)) ? eta : null,
    progress: typeof progress === 'number' && Number.isFinite(progress) ? progress : null
  };
}

/** Validate a queue file (version 1). A malformed entry or job is dropped on its own. */
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

export type PollTrigger = 'upload' | 'deep-link' | 'start' | 'visible' | 'shown';

export interface QueuePollerDeps {
  queueUrl: string;
  /** Fetch options (auth); null when the account it needs is not available. */
  requestInit: () => Promise<RequestInit | null>;
  /** Keys of the volumes watched on this server (uploads, deep links). */
  watchedKeys: () => string[];
  /** Is the catalog showing this volume? */
  isShown: (key: string) => boolean;
  /** The file as last read; null when polling stops (nothing to show from it). */
  onStatus: (file: QueueFile | null) => void;
  /**
   * A volume of interest is no longer in the file. Its manifest decides: the
   * jobs are done (pulled), or it answers what is still pending there.
   */
  onDone: (
    key: string,
    entry: QueueVolume | undefined
  ) => void | Promise<boolean | PendingOnServer | void>;
  isHidden: () => boolean;
  fetch?: typeof fetch;
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
  lastPollAt = 0;

  constructor(private readonly deps: QueuePollerDeps) {}

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
      const init = await this.deps.requestInit();
      if (!init) {
        this.halt();
        return;
      }
      let file: QueueFile | null;
      try {
        file = await this.read(init);
      } catch (error) {
        const wait = QUEUE_BACKOFF_MS[Math.min(this.errors, QUEUE_BACKOFF_MS.length - 1)];
        this.errors++;
        console.warn(
          `[OCR queue] ${this.deps.queueUrl} unavailable; next look in ${wait / 1000} s:`,
          error instanceof Error ? error.message : error
        );
        this.schedule(wait);
        return;
      }
      this.errors = 0;
      this.evaluate(file);
    } finally {
      this.fetching = false;
      if (this.again) {
        this.again = false;
        this.clearTimer();
        void this.poll();
      }
    }
  }

  private async read(init: RequestInit): Promise<QueueFile> {
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string> | undefined) ?? {})
    };
    if (this.etag && this.lastFile) headers['If-None-Match'] = this.etag;
    const doFetch = this.deps.fetch ?? fetch;
    const response = await doFetch(this.deps.queueUrl, { ...init, cache: 'no-store', headers });
    if (response.status === 304 && this.lastFile) return this.lastFile;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const file = parseQueueFile(await response.json());
    if (!file) throw new Error('not a version 1 queue file');
    this.etag = response.headers.get('ETag');
    this.lastFile = file;
    return file;
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
      let wait = Math.max(MIN_INTERVAL_S, file.next_check_after ?? UNPRICED_INTERVAL_S) * 1000;
      for (const off of this.offList.values()) {
        wait = Math.min(wait, Math.max(MIN_INTERVAL_S * 1000, off.until - Date.now()));
      }
      this.schedule(wait);
    }
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
  /** `webdav` = as the connected WebDAV account (same origin only); `none` = anonymous. */
  auth: 'webdav' | 'none';
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
    (w.auth === 'webdav' || w.auth === 'none') &&
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

function saveWatches(): void {
  publishWatchedKeys();
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

export function watchedEntries(): WatchEntry[] {
  return [...loadWatches().values()];
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

/** Watch a volume the server is making OCR for, and poll its server at once. */
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
  if (options.start !== false) {
    pollerFor(input.queueUrl, input.auth, input.source).trigger(
      input.source === 'html-download' ? 'deep-link' : 'upload'
    );
  }
}

// ---------------------------------------------------------------- pulling

/** How a pull reaches the server. */
export interface PullTarget {
  queueUrl: string;
  init: RequestInit;
  source: string;
}

async function fetchBlob(url: string, init: RequestInit, what: string): Promise<Blob | null> {
  try {
    const response = await fetch(url, init);
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
  init: RequestInit,
  source: string
): Promise<void> {
  if (manifest.ocr && wantsPrimary(row)) {
    const blob = await fetchBlob(manifest.ocr.url, init, 'OCR file');
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
    const blob = await fetchBlob(layer.url, init, `OCR layer '${layer.id}'`);
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
  const inFlight = pulling.get(key);
  if (inFlight) return inFlight;
  const run = (async () => {
    try {
      const watched = loadWatches().get(key);
      const series = entry?.series ?? watched?.series;
      const volume = entry?.volume ?? watched?.volume;
      if (!series || !volume) return false;
      const row = await localRowFor(key, series, volume);
      if (!row) {
        if (watched) {
          loadWatches().delete(key); // the volume is gone: nothing left to watch
          saveWatches();
        }
        return false;
      }
      const manifestUrl = entry?.manifest
        ? new URL(entry.manifest, target.queueUrl).toString()
        : watched?.manifest_url;
      if (!manifestUrl) return false;
      const load = await loadVolumeManifest(
        manifestUrl,
        target.init.headers as Record<string, string> | undefined
      );
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
      await pullManifestFiles(row, load.manifest, target.init, watched?.source ?? target.source);
      if (loadWatches().delete(key)) saveWatches();
      return true;
    } catch (error) {
      console.warn('[OCR queue] Pull failed; it is retried on the next look:', error);
      return false;
    } finally {
      pulling.delete(key);
    }
  })();
  pulling.set(key, run);
  return run;
}

// ---------------------------------------------------------------- pollers per server

const pollers = new Map<string, QueuePoller>();

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

async function requestInitFor(
  queueUrl: string,
  auth: WatchEntry['auth']
): Promise<RequestInit | null> {
  if (auth === 'none') return { cache: 'no-store' };
  const { providerManager } = await import('$lib/util/sync/provider-manager');
  const provider = providerManager.getActiveProvider() as {
    type?: string;
    getWorkerUploadCredentials?: () => Promise<Record<string, unknown>>;
  } | null;
  if (provider?.type !== 'webdav' || !provider.getWorkerUploadCredentials) return null;
  const credentials = await provider.getWorkerUploadCredentials();
  const url = typeof credentials.webdavUrl === 'string' ? credentials.webdavUrl : '';
  const username = typeof credentials.webdavUsername === 'string' ? credentials.webdavUsername : '';
  const password = typeof credentials.webdavPassword === 'string' ? credentials.webdavPassword : '';
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url).origin === new URL(queueUrl).origin;
  } catch {
    sameOrigin = false;
  }
  // The account's password never leaves for another origin.
  if (!sameOrigin || !password) return { cache: 'no-store' };
  return { cache: 'no-store', headers: { Authorization: basicAuthHeader(username, password) } };
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
      return init ? pullCompletedVolume(key, entry, { queueUrl, init, source }) : false;
    },
    isHidden
  });
  pollers.set(queueUrl, poller);
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

/** The connected WebDAV account's queue, when it is a bunko server (`X-Mokuro-Put` recorded). */
export async function connectedBunkoQueueUrl(): Promise<string | null> {
  try {
    const { providerManager } = await import('$lib/util/sync/provider-manager');
    const provider = providerManager.getActiveProvider() as {
      type?: string;
      getWorkerUploadCredentials?: () => Promise<Record<string, unknown>>;
    } | null;
    if (provider?.type !== 'webdav' || !provider.getWorkerUploadCredentials) return null;
    const credentials = await provider.getWorkerUploadCredentials();
    if (credentials.webdavPutVerified !== true || typeof credentials.webdavUrl !== 'string') {
      return null;
    }
    return queueUrlForWebdav(credentials.webdavUrl);
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
 * App start (after providers connect): drop the old recheck entries, poll once
 * for every server with watched volumes and for the connected bunko server,
 * and follow the tab's visibility.
 */
export async function startServerOcrQueue(): Promise<void> {
  if (started) return;
  started = true;
  cleanupLegacyRecheckEntries();
  setShownListener(nudgeForShownVolumes);
  for (const w of watchedEntries()) pollerFor(w.queue_url, w.auth, w.source);
  const connected = await connectedBunkoQueueUrl();
  if (connected) pollerFor(connected, 'webdav', 'webdav');
  for (const p of pollers.values()) p.trigger('start');
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      for (const p of pollers.values()) p.onVisibilityChange();
    });
  }
}

/** Tests: forget every poller, watch and published status. */
export function resetServerOcrQueueForTest(): void {
  for (const p of pollers.values()) p.stop();
  pollers.clear();
  pulling.clear();
  statusByQueue.clear();
  queueStatusStore.set({});
  watches = null;
  watchedKeyStore.set({});
  started = false;
  setShownListener(null);
  if (shownNudge) clearTimeout(shownNudge);
  shownNudge = null;
}
