/**
 * The interop rig's driver: `globalThis.__mokuroInterop` v1, the API mokuro-bunko's
 * rig specs (`interop/e2e/rig/`) call through Playwright's `page.evaluate`.
 *
 * Every method calls the stores and functions the UI calls for the same action
 * — the cloud screen's connect sequence, the navbar's sync, the volume editor's
 * rename, the volume card's delete, the reader's page turn and editor save, the
 * layer picker's Publish — so a rig run exercises the product, not a second
 * implementation of it. What a method returns is plain JSON (it crosses
 * `page.evaluate`).
 *
 * Loaded only by `+layout.svelte` under `CLOUD_TEST_HOOKS` (Vitest, or a
 * `vite build --mode interop`), by dynamic import, so a production build drops
 * this module; `scripts/check-no-test-hooks.mjs` bans its names from the bundle.
 */
import { derived, get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { listLayerIds } from '$lib/catalog/layer-store';
import {
  cloudFieldsForRemovedVolume,
  generatePlaceholders,
  indexCloudFilesByPath,
  indexCloudFilesByUuid
} from '$lib/catalog/placeholders';
import {
  describePendingOcr,
  queueKeyForVolume,
  serverOcrQueueStatus,
  watchedKeyStore
} from '$lib/catalog/server-ocr-pending';
import { isMetadataOnly, isVolumeInstalled } from '$lib/catalog/volume-state';
import { cloudBunkoMergesDuplicates, cloudBunkoStatus } from '$lib/catalog/cloud-bunko-marker';
import { deleteVolumeCompletely, importFiles } from '$lib/import';
import { defaultNaming } from '$lib/import/image-only-review';
import { decideCurrent, reviewSession } from '$lib/import/review-session';
import { publishCuratedLayer, pullOwnEditLayerBeforeEdit } from '$lib/metadata/layer-sync';
import { catalogFileWritePending, settleCatalogFileWrites } from '$lib/metadata/catalog-file-sync';
import { seriesBackfillsPending, settleSeriesBackfills } from '$lib/metadata/series-backfill';
import { seriesFileWritesPending, settleSeriesFileWrites } from '$lib/metadata/series-file-sync';
import type { SeriesIndexRecord } from '$lib/metadata/series-index';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import {
  clampSpineOffset,
  flushSpineOffsetWrites,
  getSpineOffsets,
  sameSpineOffsets,
  scheduleSpineOffsetWrite
} from '$lib/metadata/spine-offsets';
import { historyDb } from '$lib/reading-history/history-db';
import { HISTORY_FOLDER } from '$lib/reading-history/paths';
import { historySyncAllowed } from '$lib/reading-history/history-sync';
import { persistPageEdit } from '$lib/reader/edit/edit-persist';
import { setBlockLines } from '$lib/reader/edit/edit-ops';
import { forksOnEdit } from '$lib/reader/edit/layer-kind';
import { EDIT_LAYER_ID } from '$lib/reader/edit/layer-names';
import {
  forkIntoEditLayer,
  listLayers,
  loadLayerPages,
  persistLayerPageEdit
} from '$lib/reader/edit/layers';
import { recordPagedPageView } from '$lib/reader/paged-progress';
import { runLayerAction } from '$lib/components/Reader/Layers/layer-actions';
import {
  deleteVolume as deleteVolumeStats,
  updateVolumeSetting,
  volumes as volumeDataStore
} from '$lib/settings/volume-data';
import type { Page, VolumeMetadata } from '$lib/types';
import { backupQueue, backupQueueSettled } from '$lib/util/backup-queue';
import { downloadQueue } from '$lib/util/download-queue';
import { nav } from '$lib/util/hash-router';
import { sanitizeRenameTitle } from '$lib/util/sanitize-title';
import { waitFor } from '$lib/util/store-wait';
import { generateDeterministicUUID } from '$lib/util/series-extraction';
import { executeRenameSeries } from '$lib/util/series-rename';
import { activeProviderStatus } from '$lib/util/sync/active-provider-status';
import { canDeleteSeriesOnServer } from '$lib/util/sync/metadata-permissions';
import type { ProviderStatus, ProviderType } from '$lib/util/sync/provider-interface';
import { providerManager } from '$lib/util/sync/provider-manager';
import {
  unifiedCloudManager,
  type CloudVolumeWithProvider
} from '$lib/util/sync/unified-cloud-manager';
import { uploadFailures } from '$lib/util/upload-failures';
import { renameVolumeInCloud, updateVolumeInDb, updateVolumeStats } from '$lib/util/volume-editor';

export const RIG_DRIVER_API_VERSION = 1;

/**
 * What this branch supports, by the contract's names. A rig spec that needs a
 * capability not listed fails (unless bunko's `pending-reader-caps.txt` lists
 * it). Each one is here because its code is:
 * - `history`: per-device history files on every sync, gated by the server
 *   (`reading-history/history-sync.ts` `syncHistory`, `historySyncAllowed`).
 * - `positions`: `positions.json` on every sync (`positions/positions-sync.ts`).
 * - `edit-layers-personal`: edits go into the account's own `edit` layer and up
 *   as `<Volume>.edit.mokuro` (`reader/edit/edit-persist.ts`, `layer-names.ts`
 *   `isPersonalLayerId`, `metadata/layer-sync.ts` push rules).
 * - `edit-layers-curated`: Publish/Unpublish of the shared `curated` layer
 *   (`metadata/layer-sync.ts` `publishCuratedLayer`, `canPublishCurated`).
 * - `provenance`: the `.mokuro` provenance block, carried through renames
 *   (`catalog/ocr-provenance.ts`).
 * - `case-merge-rename`: a server's case-merged series spelling is adopted
 *   locally (`util/sync/cloud-spelling-adoption.ts`).
 * - `dedup`: duplicate-folder merges, stepping aside for a Bunko holder that
 *   merges itself (`util/sync/folder-deduplicator.ts`, `cloudBunkoMergesDuplicates`).
 */
export const RIG_CAPABILITIES: readonly string[] = [
  'history',
  'positions',
  'edit-layers-personal',
  'edit-layers-curated',
  'provenance',
  'case-merge-rename',
  'dedup'
];

export interface RigVolume {
  id: string;
  series: string;
  title: string;
  /** The listed archive's path (`<Series>/<Volume>.cbz`), or null when the cloud lists none. */
  cloudPath: string | null;
  /** The volume's OCR is on this device. */
  hasOcr: boolean;
  /** Layer ids this device holds for it, sorted. */
  layers: string[];
}

/** A value as it arrives on the far side of `page.evaluate`. */
function plain<T>(value: T): T {
  return value === undefined ? (null as T) : JSON.parse(JSON.stringify(value));
}

async function requireRow(volumeId: string): Promise<VolumeMetadata> {
  const row = await db.volumes.get(volumeId);
  if (!row) throw new Error(`No volume ${volumeId} on this device`);
  return row;
}

/**
 * The cloud screen's connect: login, make it THE provider, list, then the
 * post-login sync. Its handlers publish the status once the listing is in,
 * except the WebDAV login's, which leaves that to the provider: so here too.
 */
async function connect(type: ProviderType, credentials?: Record<string, unknown>) {
  const provider = await providerManager.getOrLoadProvider(type);
  await provider.login(credentials);
  await providerManager.setCurrentProvider(provider);
  await unifiedCloudManager.fetchAllCloudVolumes();
  if (type !== 'webdav') providerManager.updateStatus();
  const synced = await sync();
  return { status: providerStatus(), sync: synced };
}

/** A sync as on app start or after a connect: the listing, then the progress round trip. */
async function sync(): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  try {
    await unifiedCloudManager.fetchAllCloudVolumes();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const result = await unifiedCloudManager.syncProgress();
  if (result.totalProviders === 0) errors.push('Not connected');
  for (const r of result.results) if (!r.success) errors.push(r.error ?? 'Sync failed');
  return { ok: errors.length === 0, errors };
}

/**
 * Resolves once no progress sync and no cloud listing is in flight: the ones the
 * app starts by itself (after a sign-in, when a reader opens, after a re-auth), so
 * what a rig spec arranges next (a fault on the next write) meets its own sync.
 */
async function idle(): Promise<void> {
  const busy = derived(
    [unifiedCloudManager.isSyncing, unifiedCloudManager.isFetching],
    ([syncing, fetching]) => syncing || fetching
  );
  await waitFor(busy, (b) => !b);
}

/**
 * The connected provider's status as the app last published it: what the
 * banner and the read-only gates show. Never refreshed here, so a change the
 * app does not publish is one a spec does not see either.
 */
function providerStatus(): ProviderStatus | null {
  return plain(get(activeProviderStatus));
}

/**
 * The listing as the provider cache holds it NOW, in `cloudFiles`' shape (by
 * folder, history left out, each file tagged with its provider). Not
 * `get(cloudFiles)`: that store publishes the cache's incremental updates (a
 * rename's moves, an upload) up to `CACHE_MUTATION_COALESCE_MS` late, so a
 * method called right after a rename would still see the old names, where
 * the UI, a human's click later, sees the new ones.
 */
function listingNow(): Map<string, CloudVolumeWithProvider[]> {
  // The active cache is the active provider's (cacheManager), so its files are that provider's.
  const type = providerManager.getActiveProvider()?.type;
  const map = new Map<string, CloudVolumeWithProvider[]>();
  for (const file of unifiedCloudManager.getAllCloudVolumes() as CloudVolumeWithProvider[]) {
    const folder = file.path.split('/')[0];
    if (!folder || folder === HISTORY_FOLDER) continue;
    let files = map.get(folder);
    if (!files) map.set(folder, (files = []));
    files.push(type ? { ...file, provider: type } : file);
  }
  return map;
}

/**
 * The listed archive of a row, by the rule the volume card uses, in `listing`
 * (one `listingNow()` read for a whole library).
 */
function listedArchivePath(
  row: VolumeMetadata,
  listing: Map<string, CloudVolumeWithProvider[]> = listingNow()
): string | null {
  const path = `${row.series_title}/${row.volume_title}.cbz`;
  const listed = listing.get(row.series_title) ?? [];
  return listed.some((f) => f.path === path) ? path : null;
}

async function seriesIndexMap(): Promise<Map<string, SeriesIndexRecord>> {
  return new Map((await db.series_index.toArray()).map((r) => [r.series_key, r]));
}

async function library(): Promise<{ volumes: RigVolume[] }> {
  const rows = await db.volumes.toArray();
  const indexMap = await seriesIndexMap();
  const listing = listingNow();
  const placeholders = generatePlaceholders(listing, rows, indexMap);
  const out: RigVolume[] = [];
  for (const row of rows) {
    out.push({
      id: row.volume_uuid,
      series: row.series_title,
      title: row.volume_title,
      cloudPath: listedArchivePath(row, listing) ?? row.cloudPath ?? null,
      hasOcr: isVolumeInstalled(row) && !!row.mokuro_version,
      layers: (await listLayerIds(db, row.volume_uuid)).sort()
    });
  }
  for (const p of placeholders) {
    out.push({
      id: p.volume_uuid,
      series: p.series_title,
      title: p.volume_title,
      cloudPath: p.cloudPath ?? null,
      hasOcr: false,
      layers: []
    });
  }
  out.sort((a, b) => a.series.localeCompare(b.series) || a.title.localeCompare(b.title));
  return { volumes: out };
}

/**
 * A volume as its catalog card holds it, ready for the card's Download: a
 * metadata-only row decorated with its listed archive, or a cloud-only volume's
 * placeholder (the same join `volumesWithPlaceholders` makes). Null when this
 * device has no such volume.
 */
async function cardVolume(volumeId: string): Promise<VolumeMetadata | null> {
  const files = listingNow();
  const indexMap = await seriesIndexMap();
  const decorated = (row: VolumeMetadata): VolumeMetadata => {
    if (!isMetadataOnly(row)) return row;
    const fields = cloudFieldsForRemovedVolume(
      indexCloudFilesByPath(files),
      row,
      undefined,
      indexCloudFilesByUuid(files, indexMap)
    );
    return { ...row, ...fields };
  };
  const row = await db.volumes.get(volumeId);
  if (row) return decorated(row);
  const rows = await db.volumes.toArray();
  const placeholders = generatePlaceholders(files, rows, indexMap);
  // Listed before its series index arrived (in the background, after a
  // listing): the card then carried the id its path gives, the index's since.
  const byPath = (v: VolumeMetadata) =>
    generateDeterministicUUID(`${v.series_title}/${v.volume_title}`) === volumeId;
  const placeholder =
    placeholders.find((p) => p.volume_uuid === volumeId) ?? placeholders.find(byPath);
  if (placeholder) return placeholder;
  // ...and the app may since have made it a metadata-only row (a cover
  // request, the series backfill), which shadows the placeholder.
  const materialized = rows.find((r) => isMetadataOnly(r) && byPath(r));
  return materialized ? decorated(materialized) : null;
}

/** The card's Download, to the end: resolves once the volume left the queue. */
async function download(volume: VolumeMetadata): Promise<void> {
  if (!volume.cloudFileId) {
    throw new Error(`${volume.volume_title} has nowhere to download it from`);
  }
  const queued = (q: { volumeUuid: string }[]) =>
    q.some((i) => i.volumeUuid === volume.volume_uuid);
  downloadQueue.queueVolume(volume); // adds it synchronously, or refuses it
  if (!queued(get(downloadQueue))) {
    throw new Error(`${volume.volume_title} could not be queued for download`);
  }
  await waitFor(downloadQueue, (q) => !queued(q));
}

/**
 * The reader for a volume. One not on this device is downloaded first, as its
 * card's Download does (the card opens nothing by itself); the volume opened is
 * answered, by the uuid the download installed it under.
 */
async function open(volumeId: string): Promise<{ id: string }> {
  let row: VolumeMetadata | null = (await db.volumes.get(volumeId)) ?? null;
  if (!row || !isVolumeInstalled(row)) {
    const volume = await cardVolume(volumeId);
    if (!volume) throw new Error(`No volume ${volumeId} on this device`);
    await download(volume);
    row = await installedAs(volume);
    if (!row) throw new Error(`${volume.volume_title} was not installed by its download`);
  }
  nav.toReader(row.series_uuid, row.volume_uuid);
  return { id: row.volume_uuid };
}

/** The row a download installed: the placeholder's uuid, else the same titles. */
async function installedAs(volume: VolumeMetadata): Promise<VolumeMetadata | null> {
  const byUuid = await db.volumes.get(volume.volume_uuid);
  if (byUuid && isVolumeInstalled(byUuid)) return byUuid;
  const series = normalizeSeriesKey(volume.series_title);
  const title = normalizeVolumeTitleKey(volume.volume_title);
  const rows = await db.volumes.toArray();
  return (
    rows.find(
      (r) =>
        isVolumeInstalled(r) &&
        normalizeSeriesKey(r.series_title) === series &&
        normalizeVolumeTitleKey(r.volume_title) === title
    ) ?? null
  );
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** How long an import may take to install its volume. */
const IMPORT_TIMEOUT_MS = 120_000;

/**
 * The upload modal's import of one archive (`importFiles`), picked inside its
 * series folder: `path` is `<Series>/<Volume>.<ext>`, as a folder pick names
 * the file. An image-only archive's review is answered as a user keeping the
 * names does (the folder's series, the file's own name). Resolves with the
 * volume once it is installed.
 */
async function importVolume(o: { path: string; base64: string }): Promise<{ id: string }> {
  const parts = o.path.split('/');
  if (parts.length !== 2 || !parts[0] || !/^.+\.[^.]+$/.test(parts[1])) {
    throw new Error(`${o.path}: name the archive <Series>/<Volume>.<ext>`);
  }
  const [series, name] = parts;
  const title = name.replace(/\.[^.]+$/, '');
  const file = new File([fromBase64(o.base64)], name);
  Object.defineProperty(file, 'webkitRelativePath', { value: o.path });
  const answered = new Set<string>();
  const unsubscribe = reviewSession.subscribe((state) => {
    const head = state.pending[0];
    if (!head || answered.has(head.group.id)) return;
    answered.add(head.group.id);
    // After the store update that showed it, as the dialog's click comes.
    queueMicrotask(() => {
      if (get(reviewSession).pending[0]?.group.id !== head.group.id) return;
      decideCurrent({ action: 'import', naming: defaultNaming(head.group, 'folder') });
    });
  });
  try {
    const result = await importFiles([file]);
    if (!result.success) throw new Error(result.errors.join('; ') || `${o.path} did not import`);
    const deadline = Date.now() + IMPORT_TIMEOUT_MS;
    const seriesKey = normalizeSeriesKey(series);
    const titleKey = normalizeVolumeTitleKey(title);
    for (;;) {
      const row = (await db.volumes.toArray()).find(
        (r) =>
          isVolumeInstalled(r) &&
          normalizeSeriesKey(r.series_title) === seriesKey &&
          normalizeVolumeTitleKey(r.volume_title) === titleKey
      );
      if (row) return { id: row.volume_uuid };
      if (Date.now() > deadline) throw new Error(`${o.path} was not installed by its import`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    unsubscribe();
  }
}

/**
 * The volume card's Backup (`queueVolumeForBackup`), to the end of its run:
 * the upload, then the run's listing and its `series.json` / `catalog.json`
 * writes. Answers where the cloud lists the archive, or why the upload failed.
 */
async function backupVolume(
  volumeId: string
): Promise<{ cloudPath: string | null; error?: string }> {
  const row = await requireRow(volumeId);
  // A failure stays recorded until an upload of the volume succeeds, and a run
  // can end neither way (a series closed while queued): only one this run
  // recorded is its answer.
  const earlier = get(uploadFailures)[volumeId];
  backupQueue.queueVolumeForBackup(row);
  if (!backupQueue.isVolumeInBackupQueue(volumeId)) {
    throw new Error(`${row.volume_title} could not be queued for backup`);
  }
  await backupQueueSettled();
  const failure = get(uploadFailures)[volumeId];
  if (failure && (!earlier || failure.at !== earlier.at)) {
    return { cloudPath: null, error: failure.reason };
  }
  return { cloudPath: listedArchivePath(row) };
}

/** Rounds `settleSeriesWrites` goes before it calls the writes endless. */
const SETTLE_ROUNDS = 10;

/**
 * Every metadata write the app has queued, done: what the syncs before it
 * asked to write has been written (or refused at its gate), so a spec counts
 * its PUTs without waiting out a timer. A listing's background work (the
 * spelling adoption, then the backfills behind it) queues `series.json`
 * writes after the listing and its sync resolved, and those writes queue
 * `catalog.json`: each is waited out in that order, its debounce cut short,
 * and again while any of it queued more.
 */
async function settleSeriesWrites(): Promise<void> {
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    await unifiedCloudManager.whenListingWorkSettled();
    await settleSeriesBackfills();
    await settleSeriesFileWrites();
    await settleCatalogFileWrites();
    const pending =
      unifiedCloudManager.listingWorkPending() ||
      seriesBackfillsPending() ||
      seriesFileWritesPending() ||
      catalogFileWritePending();
    if (!pending) return;
  }
  throw new Error(`metadata writes are still being queued after ${SETTLE_ROUNDS} rounds`);
}

/** The catalog card's click: the series page, by the title the card navigates with. */
async function showSeries(series: string): Promise<void> {
  nav.toSeries(series);
}

/** What the volume's card shows of the server's OCR queue (`describePendingOcr`), or null. */
async function pendingOcr(volumeId: string) {
  const volume = (await db.volumes.get(volumeId)) ?? (await cardVolume(volumeId));
  if (!volume) throw new Error(`No volume ${volumeId} on this device`);
  const key = queueKeyForVolume(volume, get(watchedKeyStore));
  return plain(describePendingOcr(get(serverOcrQueueStatus)[key], Date.now()));
}

/** The reader's page turn (paged mode), against the volume's primary pages. */
async function setPage(
  volumeId: string,
  page: number
): Promise<{ page: number; completed: boolean }> {
  const row = await requireRow(volumeId);
  const pages = (await db.volume_ocr.get(volumeId))?.pages ?? [];
  const count = pages.length || row.page_count;
  if (!Number.isInteger(page) || page < 1 || page > count) {
    throw new Error(`Page ${page} is outside 1..${count}`);
  }
  recordPagedPageView(volumeId, page, pages);
  return progress(volumeId);
}

function progress(volumeId: string): { page: number; completed: boolean } {
  const record = get(volumeDataStore)[volumeId];
  return { page: record?.progress ?? 0, completed: record?.completed ?? false };
}

/** The volume editor's save of a new title: the cloud rename gates the local one. */
async function renameVolume(volumeId: string, title: string): Promise<{ title: string }> {
  const row = await requireRow(volumeId);
  const safe = sanitizeRenameTitle(title);
  if (safe.empty) throw new Error("Volume name can't be empty or only unusable characters.");
  if (safe.value === row.volume_title) return { title: safe.value };
  await renameVolumeInCloud(row, row.series_title, safe.value);
  await updateVolumeInDb(volumeId, { volume_title: safe.value });
  updateVolumeStats(volumeId, {
    series_uuid: row.series_uuid,
    series_title: row.series_title,
    volume_title: safe.value
  });
  return { title: safe.value };
}

/**
 * The series editor's rename field, for the series the catalog card shows:
 * the card groups rows by folded title and carries its FIRST row's title and
 * series uuid, and the editor renames only that uuid's volumes. What the field
 * refuses, this throws.
 */
async function renameSeries(series: string, title: string) {
  const key = normalizeSeriesKey(series);
  const card = (await db.volumes.toArray()).find((r) => normalizeSeriesKey(r.series_title) === key);
  if (!card) throw new Error('Nothing to rename');
  const next = title.trim();
  if (!next) throw new Error('Name cannot be empty');
  if (next === card.series_title) {
    return { finalTitle: card.series_title, renamedCount: 0, failures: [] };
  }
  const result = await executeRenameSeries(card.series_title, next, card.series_uuid);
  // success-shaped zeros: the field reports them as a no-op, never a rename.
  if (result.renamedCount === 0 && result.failures.length === 0) {
    throw new Error('Nothing to rename');
  }
  return plain(result);
}

/**
 * The volume card's delete with both boxes ticked: the cloud copy first (its
 * layer files go only while this device's layer rows vouch for them), then the
 * volume, its stats and progress.
 */
async function deleteVolume(volumeId: string): Promise<{ cloud: string; error?: string }> {
  const row = await requireRow(volumeId);
  let cloud = 'not-backed-up';
  let error: string | undefined;
  if (providerManager.getActiveProvider() && listedArchivePath(row)) {
    cloud = 'not-permitted';
    const readOnly = get(activeProviderStatus)?.isReadOnly === true;
    if (!readOnly && canDeleteSeriesOnServer(row.series_title).allowed) {
      try {
        await unifiedCloudManager.deleteManagedVolume(
          row.series_title,
          row.volume_title,
          row.volume_uuid
        );
        cloud = 'deleted';
      } catch (e) {
        // As on the card: a failed cloud delete still removes the volume here.
        cloud = 'failed';
        error = e instanceof Error ? e.message : String(e);
      }
    }
  }
  await deleteVolumeCompletely(volumeId);
  deleteVolumeStats(volumeId);
  return error === undefined ? { cloud } : { cloud, error };
}

/**
 * The shelf's spine nudge, written now instead of after the drag settles. As
 * on the card, a value the shelf already shows (the record joined over the
 * published `series.json`) is not written: it would bump the record, and the
 * next sync would PUT `series.json` for nothing.
 */
async function setSpineOffset(series: string, n: number): Promise<void> {
  // Anything still queued lands first, so "already shown" is the settled value.
  await flushSpineOffsetWrites();
  const key = normalizeSeriesKey(series);
  const [record, index] = await Promise.all([
    db.series_metadata.get(key),
    db.series_index.get(key)
  ]);
  const shown = getSpineOffsets(record, index?.file);
  if (sameSpineOffsets(shown, { ...shown, spineOffset: clampSpineOffset(n) })) return;
  const written = scheduleSpineOffsetWrite(series, { spineOffset: n });
  await flushSpineOffsetWrites();
  await written;
}

/**
 * The reader's pull of the account's own `edit` overlay before a first primary
 * edit or a fork (`pullOwnEditLayerBeforeEdit`): a fetch that failed edits
 * nothing, as the reader opens nothing.
 */
async function requireOwnEditPull(volumeId: string): Promise<void> {
  if ((await pullOwnEditLayerBeforeEdit(volumeId)) === 'failed') {
    throw new Error(`Couldn't fetch this account's corrections of ${volumeId}`);
  }
}

/**
 * The editor's save of a page whose first block now reads `text`, into the
 * layer the reader shows — or, when that layer is one the account may not
 * edit in place (`forksOnEdit`), into the account's own `edit` copy, as the
 * reader's E does. `page` is 1-based, like `setPage`.
 */
async function editFirstBlock(
  volumeId: string,
  page: number,
  text: string
): Promise<{ layerId: string | null }> {
  await requireRow(volumeId);
  const pageIndex = page - 1;
  const shown = get(volumeDataStore)[volumeId]?.settings?.ocrLayer || null;
  let layerId: string | null = null;
  let pages: Page[] | null = null;
  if (shown) {
    pages = await loadLayerPages(volumeId, shown);
    if (pages) layerId = shown;
  }
  if (layerId) {
    const meta = (await listLayers(volumeId)).find((l) => l.layer_id === layerId);
    if (meta && forksOnEdit(meta, get(activeProviderStatus))) {
      await requireOwnEditPull(volumeId);
      await forkIntoEditLayer(volumeId, layerId);
      updateVolumeSetting(volumeId, 'ocrLayer', EDIT_LAYER_ID);
      layerId = EDIT_LAYER_ID;
      pages = await loadLayerPages(volumeId, EDIT_LAYER_ID);
    }
  }
  if (!layerId) {
    // The reader's E on the primary pulls the account's overlay first.
    await requireOwnEditPull(volumeId);
    pages = (await db.volume_ocr.get(volumeId))?.pages ?? null;
  }
  const current = pages?.[pageIndex];
  if (!current) throw new Error(`Volume ${volumeId} has no page ${page}`);
  if (current.blocks.length === 0) throw new Error(`Page ${page} has no text block to edit`);
  const next = setBlockLines(current, 0, [text]);
  const target = layerId;
  if (target) await persistLayerPageEdit(volumeId, target, pageIndex, next);
  else await persistPageEdit(volumeId, pageIndex, next);
  return { layerId };
}

/** The layer picker's Publish, its confirmation answered yes. */
async function publishCurated(volumeId: string): Promise<{ outcome: string; message: string }> {
  await requireRow(volumeId);
  let outcome = 'failed';
  let message = '';
  await runLayerAction('publish', {
    volumeUuid: volumeId,
    layerId: EDIT_LAYER_ID,
    displayedPages: [],
    onSelectLayer: (id) => updateVolumeSetting(volumeId, 'ocrLayer', id ?? undefined),
    deps: {
      confirm: async () => true,
      notify: (m) => (message = m),
      publishCuratedLayer: async (uuid) => {
        const result = await publishCuratedLayer(uuid);
        outcome = result;
        return result;
      }
    }
  });
  return { outcome, message };
}

/** The layer picker's selection (`null` = the primary OCR). */
async function selectLayer(volumeId: string, layerId: string | null): Promise<void> {
  await requireRow(volumeId);
  updateVolumeSetting(volumeId, 'ocrLayer', layerId ?? undefined);
}

/**
 * The connected library's Bunko control state: the marker verdict, whether
 * the server compiles the metadata files, and whether this reader holds its
 * own duplicate merge because the lease holder merges them itself.
 */
function controlState() {
  const provider = providerManager.getActiveProvider();
  if (!provider) return { marker: null, serverCompilesMetadata: false, held: false };
  return plain({
    marker: cloudBunkoStatus(provider.type) ?? null,
    serverCompilesMetadata: provider.getStatus().serverCompilesMetadata === true,
    held: cloudBunkoMergesDuplicates(provider.type)
  });
}

/** Whether history syncs with this provider, and the devices this one knows of. */
async function historyStatus(): Promise<{ enabled: boolean; devices: string[] }> {
  const status = providerManager.getActiveProvider()?.getStatus();
  const devices = (await historyDb().devices.toArray()).map((d) => d.device).sort();
  return { enabled: status ? historySyncAllowed(status) : false, devices };
}

export function createRigDriver() {
  return {
    apiVersion: RIG_DRIVER_API_VERSION,
    capabilities: [...RIG_CAPABILITIES],
    connectWebDAV: (o: { url: string; username?: string; password?: string }) =>
      connect('webdav', {
        serverUrl: o.url,
        username: o.username ?? '',
        password: o.password ?? ''
      }),
    connectMega: (o: { email: string; password: string }) =>
      connect('mega', { email: o.email, password: o.password }),
    connectDrive: () => connect('google-drive'),
    connectOneDrive: () => connect('onedrive'),
    logout: () => providerManager.logout(),
    sync,
    library,
    open,
    setPage,
    progress,
    renameVolume,
    renameSeries,
    deleteVolume,
    setSpineOffset,
    editFirstBlock,
    publishCurated,
    selectLayer,
    providerStatus,
    controlState,
    historyStatus,
    // Within v1, added for the rig's dav and api suites.
    showSeries,
    pendingOcr,
    // ...and for the direct suite.
    idle,
    // ...and for the shared suite.
    importVolume,
    backupVolume,
    // ...and for the spine offset scenario (S8).
    settleSeriesWrites
  };
}

export type RigDriver = ReturnType<typeof createRigDriver>;

/** Put the driver on `globalThis.__mokuroInterop` (once). */
function installRigDriver(): RigDriver {
  const g = globalThis as Record<string, unknown>;
  const existing = g.__mokuroInterop as RigDriver | undefined;
  if (existing?.apiVersion === RIG_DRIVER_API_VERSION) return existing;
  const driver = createRigDriver();
  g.__mokuroInterop = driver;
  return driver;
}

export { installRigDriver as install };
