import { get } from 'svelte/store';
import { parseMokuroFile } from '$lib/import/processing';
import type { SeriesFileVolume } from '$lib/metadata/series-file';
import { getSeriesIndex } from '$lib/metadata/series-index';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import { groupSeriesSidecarFiles } from '$lib/metadata/cloud-sidecar-stamps';
import type { Page, VolumeMetadata } from '$lib/types';
import { currentView } from '$lib/util/hash-router';
import { showSnackbar } from '$lib/util/snackbar';
import { cacheManager } from '$lib/util/sync/cache-manager';
import type {
  CloudFileMetadata,
  ProviderType,
  SyncProvider
} from '$lib/util/sync/provider-interface';
import { providerManager } from '$lib/util/sync/provider-manager';
import {
  applyCloudPrimaryOcr,
  attestationOfListedFile,
  decodeMokuroSidecar,
  type CloudPrimaryOutcome
} from './cloud-ocr-upgrade';
import { isMokuroSha256, sha256Hex } from './mokuro-hash';
import { volumesForFoldedSeriesTitle } from './volumes-by-series';
import { isVolumeInstalled } from './volume-state';

/**
 * The automatic OCR upgrade: when the cloud's `.mokuro` for an INSTALLED
 * volume changes, re-fetch it and swap the new OCR in — decided from
 * `series.json`'s per-volume `mokuro_sha256` against the hash the volume's
 * primary was installed from (`VolumeMetadata.mokuro_sha256`).
 *
 * Runs after a listing refreshed `series.json` copies (`series-index-sync.ts`)
 * and on series open (`series-open.ts`), with the same temperament as every
 * other post-listing pass: background, best-effort, bound to the provider the
 * request named, single-flight (a request arriving mid-run is merged into ONE
 * follow-up run), at most {@link MAX_CONCURRENT_OCR_DOWNLOADS} downloads in
 * flight, failures logged at debug and retried by the next pass, and ONE
 * summary notice per run — never one per volume.
 *
 * Per installed volume whose index entry (matched by `volume_uuid`, else by
 * folded `volume_title`: a server re-OCR can mint a new uuid — the LOCAL uuid
 * is kept) carries a hash:
 *
 * - equal to the volume's → nothing;
 * - different → download the PRIMARY sidecar (`<Volume>.mokuro`, else
 *   `.mokuro.gz`; never a layer file) and apply it (`applyCloudPrimaryOcr`):
 *   an unedited primary is replaced, an edited one gets the file as the
 *   `updated-ocr` layer, the same OCR under other bytes only records the hash;
 * - ABSENT on the volume (installed before hashes existed) → the same
 *   download, as a one-time baseline: equal pages only record the hash.
 *
 * No entry with a hash (an older server, plain storage that never published
 * one) → no work and no download at all.
 *
 * A volume open in the reader (or its text view) is DEFERRED, not swapped
 * under the user: `currentVolumeData` re-reads the pages whenever the row
 * changes, which would move text — and an OCR edit session — mid-page. Its
 * series is retried by the next pass.
 */

export const MAX_CONCURRENT_OCR_DOWNLOADS = 4;

interface SeriesRequest {
  title: string;
  /** The folder's files from the listing that triggered this; absent → the provider cache. */
  files?: CloudFileMetadata[];
}

interface PassRequest {
  providerType: ProviderType;
  series: Map<string, SeriesRequest>;
}

export interface OcrUpgradePassResult {
  upgraded: number;
  layered: number;
  recorded: number;
  failed: number;
  deferred: number;
}

// ---- verdict memory: files that must not be re-fetched every pass ----

/**
 * A file the pass already downloaded for an entry hash that it will keep
 * seeing and must not act on again: a page-count mismatch, or an entry whose
 * hash turned out not to describe the bytes the listing served (a stale or
 * wrong `series.json`). Keyed by the ENTRY's hash — a new entry gets a new
 * look. localStorage, like `layer-sync.ts`'s rejected files; capped.
 */
interface OcrVerdict {
  volume_uuid: string;
  sha256: string;
}

const VERDICTS_KEY = 'ocr-upgrade:verdicts';
const MAX_VERDICTS = 500;

function readVerdicts(): OcrVerdict[] {
  try {
    const raw = globalThis.localStorage?.getItem(VERDICTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is OcrVerdict =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as OcrVerdict).volume_uuid === 'string' &&
        typeof (e as OcrVerdict).sha256 === 'string'
    );
  } catch {
    return [];
  }
}

function hasVerdict(volumeUuid: string, sha256: string): boolean {
  return readVerdicts().some((e) => e.volume_uuid === volumeUuid && e.sha256 === sha256);
}

function noteVerdict(volumeUuid: string, sha256: string): void {
  try {
    const rest = readVerdicts().filter((e) => e.volume_uuid !== volumeUuid);
    const next = [...rest, { volume_uuid: volumeUuid, sha256 }].slice(-MAX_VERDICTS);
    globalThis.localStorage?.setItem(VERDICTS_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the file is simply looked at again next pass.
  }
}

// ---- planning ----

/** Is this volume on screen right now (reader or its text view)? */
function isVolumeOpen(volumeUuid: string): boolean {
  const view = get(currentView) as { type?: string; volumeId?: string };
  return (view.type === 'reader' || view.type === 'volume-text') && view.volumeId === volumeUuid;
}

function normalizeCloudPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/** The folder's own files (one level deep) from the provider's listing cache. */
function folderFilesFromCache(providerType: ProviderType, seriesKey: string): CloudFileMetadata[] {
  const files = (cacheManager.getCache(providerType)?.getAllFiles() ?? []) as CloudFileMetadata[];
  return files.filter((file) => {
    const parts = normalizeCloudPath(file.path).split('/');
    return parts.length === 2 && normalizeSeriesKey(parts[0]) === seriesKey;
  });
}

interface UpgradeTask {
  row: VolumeMetadata;
  entryHash: string;
  sidecar: CloudFileMetadata;
}

/** Match each installed row to its index entry: uuid first, else folded title. */
function entryFor(
  row: VolumeMetadata,
  byUuid: Map<string, SeriesFileVolume>,
  byTitle: Map<string, SeriesFileVolume>
): SeriesFileVolume | undefined {
  return byUuid.get(row.volume_uuid) ?? byTitle.get(normalizeVolumeTitleKey(row.volume_title));
}

async function planSeries(
  providerType: ProviderType,
  key: string,
  request: SeriesRequest,
  deferredSeries: Map<string, SeriesRequest>
): Promise<UpgradeTask[]> {
  const record = await getSeriesIndex(key);
  // The cached index must describe THIS provider's folder.
  if (!record || record.source.provider !== providerType) return [];
  const hashed = record.file.volumes.filter((entry) => isMokuroSha256(entry.mokuro_sha256));
  if (hashed.length === 0) return []; // nothing to compare against: no work, no download

  const byUuid = new Map<string, SeriesFileVolume>();
  const byTitle = new Map<string, SeriesFileVolume>();
  for (const entry of record.file.volumes) {
    byUuid.set(entry.volume_uuid, entry);
    const titleKey = normalizeVolumeTitleKey(entry.volume_title);
    if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, entry);
  }

  const rows = (await volumesForFoldedSeriesTitle(request.title, normalizeSeriesKey)).filter(
    (row) => isVolumeInstalled(row)
  );
  if (rows.length === 0) return [];

  const sidecars = groupSeriesSidecarFiles(
    request.files ?? folderFilesFromCache(providerType, key)
  );
  const tasks: UpgradeTask[] = [];
  for (const row of rows) {
    const entry = entryFor(row, byUuid, byTitle);
    const entryHash = entry?.mokuro_sha256;
    if (!entry || !isMokuroSha256(entryHash)) continue;
    if (row.mokuro_sha256 === entryHash) continue;
    // Already offered as the edited volume's `updated-ocr` layer (or the user
    // deleted that layer): the same file is nothing new.
    if (row.ocr_edited_at && row.updated_ocr_sha256 === entryHash) continue;
    if (hasVerdict(row.volume_uuid, entryHash)) continue;
    const sidecar =
      sidecars.get(normalizeVolumeTitleKey(entry.volume_title))?.mokuro ??
      sidecars.get(normalizeVolumeTitleKey(row.volume_title))?.mokuro;
    if (!sidecar) {
      console.debug(
        `[ocr-upgrade] '${row.series_title}/${row.volume_title}': the index names new OCR ` +
          'but the listing shows no primary sidecar'
      );
      continue;
    }
    if (isVolumeOpen(row.volume_uuid)) {
      deferredSeries.set(key, { title: request.title });
      continue;
    }
    tasks.push({ row, entryHash, sidecar });
  }
  return tasks;
}

// ---- execution ----

async function readSidecar(
  provider: SyncProvider,
  sidecar: CloudFileMetadata
): Promise<{ pages: Page[]; version: string; sha256: string } | null> {
  const blob = await provider.downloadFile(sidecar);
  const file = await decodeMokuroSidecar(sidecar.path, blob);
  if (!file) return null;
  const sha256 = await sha256Hex(file);
  if (!sha256) return null;
  const parsed = await parseMokuroFile(file);
  const pages = Array.isArray(parsed.pages) ? (parsed.pages as unknown as Page[]) : [];
  return { pages, version: typeof parsed.version === 'string' ? parsed.version : '', sha256 };
}

async function runTask(
  provider: SyncProvider,
  task: UpgradeTask
): Promise<CloudPrimaryOutcome | 'failed' | 'deferred'> {
  const { row, entryHash, sidecar } = task;
  let read: Awaited<ReturnType<typeof readSidecar>>;
  try {
    read = await readSidecar(provider, sidecar);
  } catch (error) {
    console.debug(`[ocr-upgrade] could not read '${sidecar.path}':`, error);
    return 'failed';
  }
  if (!read) {
    console.debug(`[ocr-upgrade] '${sidecar.path}' is not a readable mokuro file`);
    noteVerdict(row.volume_uuid, entryHash);
    return 'skipped';
  }
  // Opened while the file was downloading: leave it for the next pass.
  if (isVolumeOpen(row.volume_uuid)) return 'deferred';

  const outcome = await applyCloudPrimaryOcr(row.volume_uuid, {
    provider: provider.type,
    pages: read.pages,
    version: read.version,
    sha256: read.sha256,
    cloud: attestationOfListedFile(provider.type, sidecar)
  });
  if (read.sha256 !== entryHash) {
    // The listing served other bytes than the index describes (a stale or
    // wrong `series.json`): what they were is applied, and this entry is not
    // re-fetched until it changes.
    console.debug(
      `[ocr-upgrade] '${sidecar.path}' hashes to ${read.sha256}, the index says ${entryHash}`
    );
    noteVerdict(row.volume_uuid, entryHash);
  } else if (outcome === 'mismatch') {
    noteVerdict(row.volume_uuid, entryHash);
  }
  return outcome;
}

async function runPool<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  });
  await Promise.all(workers);
}

function noticeFor(result: OcrUpgradePassResult): string | null {
  const parts: string[] = [];
  const plural = (n: number) => (n === 1 ? 'volume' : 'volumes');
  if (result.upgraded > 0)
    parts.push(`Updated OCR for ${result.upgraded} ${plural(result.upgraded)}`);
  if (result.layered > 0) {
    parts.push(
      `New OCR for ${result.layered} edited ${plural(result.layered)} added as the ` +
        `"Updated OCR" layer`
    );
  }
  return parts.length > 0 ? parts.join('. ') : null;
}

/** Series to look at again: a failure, or a volume that was open. */
const retrySeries = new Map<string, SeriesRequest>();

async function runPass(request: PassRequest): Promise<OcrUpgradePassResult> {
  const result: OcrUpgradePassResult = {
    upgraded: 0,
    layered: 0,
    recorded: 0,
    failed: 0,
    deferred: 0
  };
  const provider = providerManager.getActiveProvider();
  if (!provider || provider.type !== request.providerType) return result;

  // Last pass's leftovers ride along (their files come from the cache).
  const series = new Map(request.series);
  for (const [key, entry] of retrySeries) if (!series.has(key)) series.set(key, entry);
  retrySeries.clear();

  const tasks: Array<{ key: string; title: string; task: UpgradeTask }> = [];
  const deferred = new Map<string, SeriesRequest>();
  for (const [key, seriesRequest] of series) {
    try {
      for (const task of await planSeries(request.providerType, key, seriesRequest, deferred)) {
        tasks.push({ key, title: seriesRequest.title, task });
      }
    } catch (error) {
      console.debug(`[ocr-upgrade] could not plan '${seriesRequest.title}':`, error);
    }
  }
  result.deferred += deferred.size;
  for (const [key, entry] of deferred) retrySeries.set(key, entry);

  await runPool(tasks, MAX_CONCURRENT_OCR_DOWNLOADS, async ({ key, title, task }) => {
    // The account can change mid-run: stop, never cross-account.
    if (providerManager.getActiveProvider()?.type !== request.providerType) return;
    let outcome: Awaited<ReturnType<typeof runTask>>;
    try {
      outcome = await runTask(provider, task);
    } catch (error) {
      console.debug(`[ocr-upgrade] could not upgrade '${task.row.volume_title}':`, error);
      outcome = 'failed';
    }
    if (outcome === 'upgraded') result.upgraded++;
    else if (outcome === 'layered') result.layered++;
    else if (outcome === 'recorded') result.recorded++;
    else if (outcome === 'failed' || outcome === 'deferred') {
      if (outcome === 'failed') result.failed++;
      else result.deferred++;
      retrySeries.set(key, { title });
    }
  });

  if (result.upgraded || result.layered || result.recorded || result.failed) {
    console.log(
      `[ocr-upgrade] upgraded ${result.upgraded}, layered ${result.layered}, ` +
        `recorded ${result.recorded}, failed ${result.failed}, deferred ${result.deferred}`
    );
  }
  const notice = noticeFor(result);
  if (notice) showSnackbar(notice, 5000);
  return result;
}

let inFlight: Promise<void> | null = null;
let queued: PassRequest | null = null;
let lastResult: OcrUpgradePassResult | null = null;

function mergeInto(target: PassRequest, next: PassRequest): PassRequest {
  if (target.providerType !== next.providerType) return next; // the newer account wins
  for (const [key, entry] of next.series) target.series.set(key, entry);
  return target;
}

/**
 * Run the upgrade pass over these series (by folder title) for the provider
 * whose listing named them. `files`, when given, are each folder's files from
 * that listing; otherwise the provider's listing cache is read.
 *
 * Never rejects. Single-flight: a request arriving while a run is in flight is
 * merged into ONE follow-up run. The promise resolves when the whole chain is
 * done (tests await it; the app fires and forgets).
 */
export function requestOcrUpgradePass(
  providerType: ProviderType,
  series: Array<{ title: string; files?: CloudFileMetadata[] }>
): Promise<void> {
  const request: PassRequest = { providerType, series: new Map() };
  for (const s of series) {
    const key = normalizeSeriesKey(s.title);
    if (key) request.series.set(key, { title: s.title, ...(s.files ? { files: s.files } : {}) });
  }
  if (request.series.size === 0 && retrySeries.size === 0) return inFlight ?? Promise.resolve();

  if (inFlight) {
    queued = queued ? mergeInto(queued, request) : request;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      let current: PassRequest | null = request;
      while (current) {
        try {
          lastResult = await runPass(current);
        } catch (error) {
          console.debug('[ocr-upgrade] pass failed:', error);
        }
        current = queued;
        queued = null;
      }
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Test hooks. */
export function _lastOcrUpgradeResultForTests(): OcrUpgradePassResult | null {
  return lastResult;
}
export function _resetOcrUpgradePassForTests(): void {
  retrySeries.clear();
  queued = null;
  lastResult = null;
  try {
    globalThis.localStorage?.removeItem(VERDICTS_KEY);
  } catch {
    // ignore
  }
}
