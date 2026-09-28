import { db } from '$lib/catalog/db';
import { getLayerMeta } from '$lib/catalog/layer-store';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import {
  loadVolumeManifest,
  type ManifestPendingJob,
  type VolumeManifest
} from '$lib/import/deep-link-manifest';
import type { FetchedLayerFile } from '$lib/metadata/layer-sync';
import type { VolumeMetadata } from '$lib/types';
import { basicAuthHeader } from '$lib/util/base64';
import { pendingStore } from './server-ocr-pending';

export { describePendingOcr, serverOcrPending } from './server-ocr-pending';

/**
 * Targeted rechecks of a server's OCR queue for one volume.
 *
 * A server that OCRs what it receives (mokuro-bunko) prices every queued job
 * and says when to look again: a WebDAV `.cbz` upload answers with
 * `X-Mokuro-Manifest` / `X-Mokuro-Recheck-After`, and a deep link's manifest
 * carries `pending` / `recheck_after`. Each such volume gets one persisted
 * entry here; when it is due (a timer while the app is open, and again on app
 * start) the manifest is read and whatever it lists that this device lacks is
 * pulled through the same paths a deep link uses — the primary through the
 * cloud OCR upgrade (image-only volumes only), layers through the shared layer
 * importer.
 *
 * An entry ends when nothing is pending and everything listed is here, after
 * 24 h, or when its volume is gone. Every failure is one `console.warn` and a
 * retry at the next recheck. The normal listing-driven layer sync still runs;
 * this only adds a look at the predicted time.
 */

export const RECHECK_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** When there is nothing better to go on (unpriced, failed, or still missing files). */
export const RECHECK_FALLBACK_SECONDS = 300;
const STORAGE_KEY = 'server-ocr-rechecks:v1';

export interface ServerOcrRecheck {
  volume_uuid: string;
  manifest_url: string;
  /**
   * How to authenticate the fetches: `webdav` = as the connected WebDAV account
   * (same origin only), `none` = the fetch default, as the deep link did.
   */
  auth: 'webdav' | 'none';
  /** The `cloud.provider` stamp a pulled layer row gets (`importFetchedLayers`). */
  source: string;
  /** Epoch ms of the first registration: the 24 h clock. */
  registered_at: number;
  /** Epoch ms the next look is due. */
  recheck_at: number;
  /** The server's jobs as last read; null until the manifest has been read once. */
  pending: ManifestPendingJob[] | null;
}

export interface RegisterRecheckInput {
  volumeUuid: string;
  manifestUrl: string;
  /** Seconds until the first look; null → the fallback. */
  recheckAfter: number | null;
  auth: ServerOcrRecheck['auth'];
  source: string;
  pending?: ManifestPendingJob[] | null;
  /**
   * Read the manifest once right away, only to learn the jobs and their ETAs
   * for the chip (an upload's headers carry neither). Pulls nothing and keeps
   * the recheck time the server asked for.
   */
  peek?: boolean;
}

let entries: Map<string, ServerOcrRecheck> | null = null;

function isEntry(value: unknown): value is ServerOcrRecheck {
  const e = value as ServerOcrRecheck;
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.volume_uuid === 'string' &&
    typeof e.manifest_url === 'string' &&
    (e.auth === 'webdav' || e.auth === 'none') &&
    typeof e.source === 'string' &&
    typeof e.registered_at === 'number' &&
    typeof e.recheck_at === 'number'
  );
}

function load(): Map<string, ServerOcrRecheck> {
  if (entries) return entries;
  entries = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (isEntry(e)) entries.set(e.volume_uuid, { ...e, pending: e.pending ?? null });
      }
    }
  } catch {
    // Unreadable storage: start empty; the listing sync still delivers layers.
  }
  publish();
  return entries;
}

function publish(): void {
  const view: Record<string, ManifestPendingJob[] | null> = {};
  for (const e of entries?.values() ?? []) {
    if (e.pending === null || e.pending.length > 0) view[e.volume_uuid] = e.pending;
  }
  pendingStore.set(view);
}

function persist(): void {
  publish();
  try {
    const list = [...(entries?.values() ?? [])];
    if (list.length === 0) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: the recheck lives for this session only.
  }
}

function secondsOr(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : RECHECK_FALLBACK_SECONDS;
}

/**
 * Remember (or refresh) the recheck of one volume. A volume that registers
 * again keeps its first registration time, so the 24 h limit is not reset by
 * a re-upload loop.
 */
export function registerServerOcrRecheck(input: RegisterRecheckInput, now = Date.now()): void {
  const all = load();
  const existing = all.get(input.volumeUuid);
  all.set(input.volumeUuid, {
    volume_uuid: input.volumeUuid,
    manifest_url: input.manifestUrl,
    auth: input.auth,
    source: input.source,
    registered_at: existing?.registered_at ?? now,
    recheck_at: now + secondsOr(input.recheckAfter) * 1000,
    pending: input.pending !== undefined ? input.pending : (existing?.pending ?? null)
  });
  persist();
  scheduleNext();
  if (input.peek) void peekPending(input.volumeUuid);
}

/** Fill in the jobs of a fresh entry. Quiet on every failure: the recheck still runs. */
export async function peekPending(volumeUuid: string): Promise<void> {
  try {
    const entry = load().get(volumeUuid);
    if (!entry) return;
    const init = await fetchOptions(entry);
    if (!init) return;
    const result = await loadVolumeManifest(
      entry.manifest_url,
      init.headers as Record<string, string> | undefined
    );
    if ('error' in result) {
      console.warn(`[OCR recheck] Manifest ${entry.manifest_url} unavailable:`, result.error);
      return;
    }
    const current = load().get(volumeUuid);
    if (!current || current.manifest_url !== entry.manifest_url) return;
    load().set(volumeUuid, { ...current, pending: result.manifest.pending });
    persist();
  } catch (error) {
    console.warn('[OCR recheck] Could not read the queued jobs:', error);
  }
}

function drop(volumeUuid: string): void {
  load().delete(volumeUuid);
  persist();
}

function reschedule(
  entry: ServerOcrRecheck,
  now: number,
  seconds: number | null,
  pending?: ManifestPendingJob[]
) {
  load().set(entry.volume_uuid, {
    ...entry,
    recheck_at: now + secondsOr(seconds) * 1000,
    ...(pending ? { pending } : {})
  });
  persist();
}

/** The fetch options of one recheck; null when its account is not available. */
async function fetchOptions(entry: ServerOcrRecheck): Promise<RequestInit | null> {
  if (entry.auth === 'none') return { cache: 'no-store' };
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
    sameOrigin = new URL(url).origin === new URL(entry.manifest_url).origin;
  } catch {
    sameOrigin = false;
  }
  // The account's password never leaves for another origin.
  if (!sameOrigin || !password) return { cache: 'no-store' };
  return { cache: 'no-store', headers: { Authorization: basicAuthHeader(username, password) } };
}

async function fetchBlob(url: string, init: RequestInit, what: string): Promise<Blob | null> {
  try {
    const response = await fetch(url, init);
    if (response.ok) return await response.blob();
    console.warn(`[OCR recheck] Could not fetch ${what} ${url}: HTTP ${response.status}`);
  } catch (error) {
    console.warn(`[OCR recheck] Could not fetch ${what} ${url}:`, error);
  }
  return null;
}

/** Does this row still want the manifest's primary? Only an image-only installed volume does. */
function wantsPrimary(row: VolumeMetadata): boolean {
  if (!isVolumeInstalled(row)) return false;
  const version = typeof row.mokuro_version === 'string' ? row.mokuro_version.trim() : '';
  return version === '' && !row.ocr_edited_at;
}

async function missingLayers(
  volumeUuid: string,
  manifest: VolumeManifest
): Promise<VolumeManifest['layers']> {
  const out: VolumeManifest['layers'] = [];
  for (const layer of manifest.layers) {
    if (!(await getLayerMeta(db, volumeUuid, layer.id))) out.push(layer);
  }
  return out;
}

async function pullMissing(
  entry: ServerOcrRecheck,
  row: VolumeMetadata,
  manifest: VolumeManifest,
  init: RequestInit
): Promise<void> {
  if (manifest.ocr && wantsPrimary(row)) {
    const blob = await fetchBlob(manifest.ocr.url, init, 'OCR file');
    if (blob) {
      const { upgradeOcrFromSidecarBlob } = await import('$lib/catalog/cloud-ocr-upgrade');
      try {
        await upgradeOcrFromSidecarBlob(row.volume_uuid, manifest.ocr.url, blob);
      } catch (error) {
        console.warn(`[OCR recheck] Could not apply OCR file ${manifest.ocr.url}:`, error);
      }
    }
  }

  const missing = await missingLayers(row.volume_uuid, manifest);
  if (missing.length === 0) return;
  const fetched: FetchedLayerFile[] = [];
  for (const layer of missing) {
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
  await importFetchedLayers(row.volume_uuid, entry.source, fetched);
}

async function recheckOne(entry: ServerOcrRecheck, now: number): Promise<void> {
  if (now - entry.registered_at >= RECHECK_GIVE_UP_MS) {
    console.log('[OCR recheck] Giving up after 24 h:', entry.volume_uuid);
    drop(entry.volume_uuid);
    return;
  }
  const row = await db.volumes.get(entry.volume_uuid);
  if (!row || row.isPlaceholder) {
    drop(entry.volume_uuid);
    return;
  }
  const init = await fetchOptions(entry);
  if (!init) {
    console.warn(
      '[OCR recheck] WebDAV account not connected; will look again later:',
      row.volume_title
    );
    reschedule(entry, now, null);
    return;
  }
  const load = await loadVolumeManifest(
    entry.manifest_url,
    init.headers as Record<string, string> | undefined
  );
  if ('error' in load) {
    console.warn(`[OCR recheck] Manifest ${entry.manifest_url} unavailable:`, load.error);
    reschedule(entry, now, null);
    return;
  }
  const manifest = load.manifest;
  await pullMissing(entry, row, manifest, init);

  const after = await db.volumes.get(entry.volume_uuid);
  if (!after || after.isPlaceholder) {
    drop(entry.volume_uuid);
    return;
  }
  const primaryMissing = !!manifest.ocr && wantsPrimary(after);
  const layersMissing = (await missingLayers(entry.volume_uuid, manifest)).length > 0;
  if (manifest.pending.length === 0 && !primaryMissing && !layersMissing) {
    drop(entry.volume_uuid);
    return;
  }
  reschedule(
    entry,
    now,
    manifest.pending.length > 0 ? manifest.recheck_after : null,
    manifest.pending
  );
}

let running: Promise<void> | null = null;

/** Run every recheck that is due, one at a time. Never rejects. */
export async function runDueServerOcrRechecks(now = Date.now()): Promise<void> {
  if (running) return running;
  running = (async () => {
    const due = [...load().values()].filter((e) => e.recheck_at <= now);
    for (const entry of due) {
      try {
        await recheckOne(entry, now);
      } catch (error) {
        console.warn('[OCR recheck] Recheck failed; will look again later:', error);
        reschedule(entry, now, null);
      }
    }
  })();
  try {
    await running;
  } finally {
    running = null;
    scheduleNext();
  }
}

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function scheduleNext(): void {
  if (!started) return;
  if (timer) clearTimeout(timer);
  timer = null;
  const all = [...load().values()];
  if (all.length === 0) return;
  const next = Math.min(...all.map((e) => e.recheck_at));
  const delay = Math.min(Math.max(next - Date.now(), 0), MAX_TIMEOUT_MS);
  timer = setTimeout(() => {
    timer = null;
    void runDueServerOcrRechecks();
  }, delay);
}

/** App start: run what came due while the app was closed, then keep a timer. */
export function startServerOcrRechecks(): void {
  if (started) return;
  started = true;
  void runDueServerOcrRechecks();
}

/** Tests: forget in-memory state (and, unless kept, the persisted entries). */
export function resetServerOcrRechecksForTest(options: { keepStorage?: boolean } = {}): void {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
  running = null;
  entries = null;
  if (!options.keepStorage) {
    try {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  pendingStore.set({});
}
