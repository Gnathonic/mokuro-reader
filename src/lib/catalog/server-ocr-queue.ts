import { db } from '$lib/catalog/db';
import { getLayerMeta } from '$lib/catalog/layer-store';
import { volumesForFoldedSeriesTitle } from '$lib/catalog/volumes-by-series';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import { loadVolumeManifest, type VolumeManifest } from '$lib/import/deep-link-manifest';
import type { FetchedLayerFile } from '$lib/metadata/layer-sync';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import type { VolumeMetadata } from '$lib/types';
import {
  authFromCredentials,
  bearerOf,
  webdavAuthorization
} from '$lib/util/sync/core/providers/webdav-authorization';
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
  return {
    version: 1,
    generated_at: typeof json.generated_at === 'string' ? json.generated_at : '',
    held,
    next_check_after: typeof next === 'number' && Number.isFinite(next) && next >= 0 ? next : null,
    volumes
  };
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
  /** A volume of interest is no longer in the file: its jobs are done. */
  onDone: (key: string, entry: QueueVolume | undefined) => void;
  isHidden: () => boolean;
  fetch?: typeof fetch;
}

export class QueuePoller {
  private etag: string | null = null;
  private lastFile: QueueFile | null = null;
  /** Interesting keys seen in the last file, with their entries (for the pull). */
  private seen = new Map<string, QueueVolume>();
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
    // Done: interesting last time and gone now, or watched and not in the file
    // (a watched volume is queued before its upload is answered, so absence is
    // completion, even if this device never saw it pending).
    const doneKeys = new Set<string>();
    for (const key of this.seen.keys()) if (!inFile.has(key)) doneKeys.add(key);
    for (const key of watched) if (!inFile.has(key)) doneKeys.add(key);
    const previous = this.seen;
    this.seen = interesting;

    if (interesting.size > 0) {
      this.deps.onStatus(file);
      this.schedule(Math.max(MIN_INTERVAL_S, file.next_check_after ?? UNPRICED_INTERVAL_S) * 1000);
    } else {
      this.halt();
    }
    for (const key of doneKeys) this.deps.onDone(key, previous.get(key));
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
 * anywhere), and a 401 under a bearer token replaces the token once — through
 * the provider's single-flight re-issue — and retries with the fresh header.
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
  const response = await fetchImpl(url, { ...init, headers });
  const sent = headers.Authorization;
  if (response.status !== 401 || auth !== 'webdav' || !bearerOf(sent)) return response;
  const provider = (await activeWebdavProvider()) as {
    reissueAfterUnauthorized?: (stale: string) => Promise<boolean>;
  } | null;
  if (!provider?.reissueAfterUnauthorized || !(await provider.reissueAfterUnauthorized(sent))) {
    return response;
  }
  const fresh = (await requestInitFor(queueUrl, auth))?.headers as
    | Record<string, string>
    | undefined;
  const retryHeaders = { ...headers };
  if (fresh?.Authorization) retryHeaders.Authorization = fresh.Authorization;
  else delete retryHeaders.Authorization;
  return fetchImpl(url, { ...init, headers: retryHeaders });
}

async function fetchBlob(
  url: string,
  init: RequestInit,
  what: string,
  target: Pick<PullTarget, 'queueUrl' | 'auth'>
): Promise<Blob | null> {
  try {
    const response = await fetchWithQueueAuth(url, init, target.queueUrl, target.auth);
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
  source: string
): Promise<void> {
  const init = target.init;
  if (manifest.ocr && wantsPrimary(row)) {
    const blob = await fetchBlob(manifest.ocr.url, init, 'OCR file', target);
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
    const blob = await fetchBlob(layer.url, init, `OCR layer '${layer.id}'`, target);
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

const pulling = new Map<string, Promise<boolean>>();

/**
 * Pull a finished volume's new sidecars through its manifest. At most one pull
 * per volume in flight (a second call gets the same promise). True when the
 * manifest was read and applied; the volume's watch then ends. Never rejects.
 */
export function pullCompletedVolume(
  key: string,
  entry: Pick<QueueVolume, 'series' | 'volume' | 'manifest'> | undefined,
  target: PullTarget
): Promise<boolean> {
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
        target.init.headers as Record<string, string> | undefined,
        (input, init) => fetchWithQueueAuth(String(input), init ?? {}, target.queueUrl, target.auth)
      );
      if ('error' in load) {
        console.warn(`[OCR queue] Manifest ${manifestUrl} unavailable:`, load.error);
        return false;
      }
      await pullManifestFiles(row, load.manifest, target, watched?.source ?? target.source);
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

async function activeWebdavProvider(): Promise<{
  type?: string;
  getWorkerUploadCredentials?: () => Promise<Record<string, unknown>>;
} | null> {
  const { providerManager } = await import('$lib/util/sync/provider-manager');
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
  // The session's header: Bearer when a token is held, else Basic, else none.
  const authorization = webdavAuthorization(authFromCredentials(credentials));
  // The account's token or password never leaves for another origin.
  if (!authorization || originOf(url) === null || originOf(url) !== originOf(queueUrl)) {
    return { cache: 'no-store' };
  }
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
    onDone: (key, entry) => {
      void (async () => {
        const init = await requestInitFor(queueUrl, auth);
        if (init) await pullCompletedVolume(key, entry, { queueUrl, init, source, auth });
      })();
    },
    isHidden,
    fetch: (input, init) => fetchWithQueueAuth(String(input), init ?? {}, queueUrl, auth)
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
    const provider = await activeWebdavProvider();
    if (!provider) return null;
    const credentials = await provider.getWorkerUploadCredentials!();
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
