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
import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { listLayerIds } from '$lib/catalog/layer-store';
import { generatePlaceholders } from '$lib/catalog/placeholders';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import { cloudBunkoMergesDuplicates, cloudBunkoStatus } from '$lib/catalog/cloud-bunko-marker';
import { deleteVolumeCompletely } from '$lib/import';
import { publishCuratedLayer, pullOwnEditLayerBeforeFork } from '$lib/metadata/layer-sync';
import type { SeriesIndexRecord } from '$lib/metadata/series-index';
import { flushSpineOffsetWrites, scheduleSpineOffsetWrite } from '$lib/metadata/spine-offsets';
import { historyDb } from '$lib/reading-history/history-db';
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
import { nav } from '$lib/util/hash-router';
import { sanitizeRenameTitle } from '$lib/util/sanitize-title';
import { executeRenameSeries } from '$lib/util/series-rename';
import { activeProviderStatus } from '$lib/util/sync/active-provider-status';
import { canDeleteSeriesOnServer } from '$lib/util/sync/metadata-permissions';
import type { ProviderStatus, ProviderType } from '$lib/util/sync/provider-interface';
import { providerManager } from '$lib/util/sync/provider-manager';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
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

/** The cloud screen's connect: login, make it THE provider, list, then the post-login sync. */
async function connect(type: ProviderType, credentials?: Record<string, unknown>) {
  const provider = await providerManager.getOrLoadProvider(type);
  await provider.login(credentials);
  await providerManager.setCurrentProvider(provider);
  await unifiedCloudManager.fetchAllCloudVolumes();
  providerManager.updateStatus();
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

function providerStatus(): ProviderStatus | null {
  providerManager.updateStatus();
  return plain(get(activeProviderStatus));
}

/** The listed archive of a row, by the rule the volume card uses. */
function listedArchivePath(row: VolumeMetadata): string | null {
  const path = `${row.series_title}/${row.volume_title}.cbz`;
  const listed = get(unifiedCloudManager.cloudFiles).get(row.series_title) ?? [];
  return listed.some((f) => f.path === path) ? path : null;
}

async function library(): Promise<{ volumes: RigVolume[] }> {
  const rows = await db.volumes.toArray();
  const indexMap = new Map<string, SeriesIndexRecord>(
    (await db.series_index.toArray()).map((r) => [r.series_key, r])
  );
  const placeholders = generatePlaceholders(get(unifiedCloudManager.cloudFiles), rows, indexMap);
  const out: RigVolume[] = [];
  for (const row of rows) {
    out.push({
      id: row.volume_uuid,
      series: row.series_title,
      title: row.volume_title,
      cloudPath: listedArchivePath(row) ?? row.cloudPath ?? null,
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

async function open(volumeId: string): Promise<void> {
  const row = await requireRow(volumeId);
  nav.toReader(row.series_uuid, volumeId);
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

/** The series editor's rename field. */
async function renameSeries(series: string, title: string) {
  const result = await executeRenameSeries(series, title.trim());
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

/** The shelf's spine nudge, written now instead of after the drag settles. */
async function setSpineOffset(series: string, n: number): Promise<void> {
  const written = scheduleSpineOffsetWrite(series, { spineOffset: n });
  await flushSpineOffsetWrites();
  await written;
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
      await pullOwnEditLayerBeforeFork(volumeId);
      await forkIntoEditLayer(volumeId, layerId);
      updateVolumeSetting(volumeId, 'ocrLayer', EDIT_LAYER_ID);
      layerId = EDIT_LAYER_ID;
      pages = await loadLayerPages(volumeId, EDIT_LAYER_ID);
    }
  }
  if (!layerId) pages = (await db.volume_ocr.get(volumeId))?.pages ?? null;
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
    historyStatus
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
