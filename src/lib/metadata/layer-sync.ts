import { db } from '$lib/catalog/db';
import {
  getLayerMeta,
  getLayerWithPages,
  listLayerMetasForVolumes,
  listVolumeUuidsWithLayers,
  patchLayerMeta,
  putLayerWithPages,
  updateLayerMeta
} from '$lib/catalog/layer-store';
import { volumesForFoldedSeriesTitle } from '$lib/catalog/volumes-by-series';
import type { Page, VolumeMetadata, VolumeOcrLayer } from '$lib/types';
import {
  layerKindForId,
  layerNameForId,
  servedEngineOf,
  titleCasedLayerId
} from '$lib/reader/edit/layers';
import { alignLayerPages } from '$lib/reader/edit/layer-page-align';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import { buildPageCharCounts } from '$lib/catalog/cloud-ocr-upgrade';
import { isUntouchedUpdatedOcr } from '$lib/catalog/mokuro-hash';
import { buildMokuroMetadata } from '$lib/util/mokuro-metadata';
import { cacheManager } from '$lib/util/sync/cache-manager';
import { uploadCacheEntry } from '$lib/util/sync/cloud-cache-interface';
import type {
  CloudFileMetadata,
  ProviderType,
  SyncProvider
} from '$lib/util/sync/provider-interface';
import { providerManager } from '$lib/util/sync/provider-manager';
import { cbzStemsOf, classifyMokuroSidecar, layerSidecarName } from '$lib/util/sync/syncable-file';
import { isoToEpochSeconds } from './cloud-sidecar-stamps';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from './series-key';

/**
 * The cloud half of OCR layers: `<Volume Title>.<layer-id>.mokuro[.gz]` files
 * beside a volume's archive (the shape mokuro-bunko's engines write) mirror
 * the `volume_ocr_layers` rows of that volume on this device.
 *
 * Rides the same post-listing hook as `series-index-sync.ts`, with the same
 * temperament: decided FROM the listing in hand (never a fetch of its own),
 * bounded downloads, every failure swallowed, bound to the provider whose
 * listing it was handed.
 *
 * - Only rows that exist locally can receive a layer (installed or
 *   metadata-only volumes). A placeholder has no row and gets nothing — a
 *   layer for a volume this device never held would be dead weight, and it
 *   arrives with the volume anyway (`pullLayersForVolume` after a download).
 * - Every stamp is the LISTING's own `size`/`modifiedTime`, compared against
 *   the row's `cloud` stamp exactly as `isSidecarStale` does for `series.json`
 *   entries: a different size, or a newer mtime, means the cloud copy moved.
 *   A provisional (client-clock) mtime stamps size only.
 * - Newest wins, no merge: a row edited locally since its last sync is pushed
 *   (writable providers) unless the cloud copy is newer than the edit, in
 *   which case the cloud copy replaces it.
 * - The `.mokuro` a push writes is pure upstream format (`buildMokuroMetadata`);
 *   the layer's kind/name are inferred from the id on the other side, never
 *   embedded.
 * - A layer may be listed twice, as `.mokuro` AND `.mokuro.gz`. The plain file
 *   wins every read; a push (always the plain name) removes the `.gz` it
 *   supersedes, and a delete removes both — see `ListedLayerFile.copies`.
 * - A layer deleted here whose cloud copy could not be removed at the time
 *   leaves a pending-delete tombstone (see `PendingLayerDelete`): its file is
 *   never pulled back, and is deleted by the first listing that can.
 */

export const MAX_CONCURRENT_LAYER_TRANSFERS = 4;

function normalizeCloudPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function basename(path: string): string {
  return normalizeCloudPath(path).split('/').pop() ?? '';
}

/** A listed layer file, resolved against the archives of its own folder. */
export interface ListedLayerFile {
  folderTitle: string;
  /** The volume title as the archive spells it (`Vol 1` of `Vol 1.cbz`). */
  stem: string;
  layerId: string;
  gz: boolean;
  file: CloudFileMetadata;
  /**
   * EVERY listed file of this layer, `file` included — a layer can sit in the
   * folder as both `.mokuro` and `.mokuro.gz` (an engine wrote the `.gz`, a
   * client pushed the plain one). Reading takes the one winner above; removing
   * must take them all, or the survivor is the layer again on the next listing.
   */
  copies: Array<{ file: CloudFileMetadata; gz: boolean }>;
}

/** The archive stems of a folder, keyed lowercased → spelled as listed. */
function archiveStemsOf(files: CloudFileMetadata[]): Map<string, string> {
  const spelled = new Map<string, string>();
  for (const file of files) {
    const name = basename(file.path);
    if (name.toLowerCase().endsWith('.cbz')) {
      const stem = name.slice(0, -4);
      spelled.set(stem.toLowerCase(), stem);
    }
  }
  return spelled;
}

/**
 * Every layer file in a listing, classified per folder by archive presence
 * (see `classifyMokuroSidecar`). Files nested deeper than `<Series>/<file>`
 * are not a volume's sidecars. When both `.mokuro` and `.mokuro.gz` exist for
 * one layer the plain file wins the READ; the entry still carries both as
 * `copies`, which is what every delete works from.
 */
export function collectLayerFiles(
  cloudFilesMap: Map<string, CloudFileMetadata[]>
): ListedLayerFile[] {
  const out: ListedLayerFile[] = [];
  for (const files of cloudFilesMap.values()) {
    const oneDeep = files.filter((f) => normalizeCloudPath(f.path).split('/').length === 2);
    if (oneDeep.length === 0) continue;
    const folderTitle = normalizeCloudPath(oneDeep[0].path).split('/')[0];
    const stems = archiveStemsOf(oneDeep);
    const cbzStems = cbzStemsOf(oneDeep.map((f) => basename(f.path)));
    const seen = new Map<string, ListedLayerFile>();
    for (const file of oneDeep) {
      const cls = classifyMokuroSidecar(basename(file.path), cbzStems);
      if (cls.kind !== 'layer') continue;
      const key = `${cls.stem.toLowerCase()}\u0000${cls.layerId}`;
      const existing = seen.get(key);
      const copies = [...(existing?.copies ?? []), { file, gz: cls.gz }];
      if (existing && !existing.gz) {
        existing.copies = copies; // plain beats gz
        continue;
      }
      seen.set(key, {
        folderTitle,
        stem: stems.get(cls.stem.toLowerCase()) ?? cls.stem,
        layerId: cls.layerId,
        gz: cls.gz,
        file,
        copies
      });
    }
    out.push(...seen.values());
  }
  return out;
}

/**
 * The parts of a listed file every stamp decision reads. A file that did not
 * come out of a listing (a deep link's manifest entry) is judged by the same
 * three fields.
 */
export type LayerFileStamp = Pick<
  CloudFileMetadata,
  'size' | 'modifiedTime' | 'modifiedTimeProvisional'
>;

/** The listing stamp of a file — size always, mtime only when the server said so. */
export function stampOf(file: LayerFileStamp): { size?: number; modified?: number } {
  return {
    size: file.size,
    modified: file.modifiedTimeProvisional ? undefined : isoToEpochSeconds(file.modifiedTime)
  };
}

/**
 * A layer the user deleted on this device whose cloud copy is not known to be
 * gone — deleted offline, on a read-only provider, while another provider was
 * connected, or the request failed. With the row gone, "no row → pull" would
 * bring the file straight back on the next listing, so the tombstone stands in
 * for the row: its file is skipped by every pull and deleted by the first
 * listing of a writable provider that shows it.
 *
 * Persisted in localStorage like `sidecar-backfill.ts`'s edited marker (a
 * handful of ids; no schema version for it). An entry leaves when the delete
 * goes through, when a listing covering the volume no longer shows the file,
 * when a row with that id exists again (re-created — the user wants it), or
 * when its volume is gone.
 */
export interface PendingLayerDelete {
  volume_uuid: string;
  layer_id: string;
  /**
   * The provider holding the copy. Another provider's listing proves nothing
   * about it, so it neither applies there nor is cleared by it. Absent = any.
   * (A plain string, like the `cloud.provider` stamp it is copied from.)
   */
  provider?: string;
}

const PENDING_DELETES_KEY = 'layer-sync:pending-deletes';

function readPendingDeletes(): PendingLayerDelete[] {
  try {
    const raw = globalThis.localStorage?.getItem(PENDING_DELETES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PendingLayerDelete =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as PendingLayerDelete).volume_uuid === 'string' &&
        typeof (e as PendingLayerDelete).layer_id === 'string'
    );
  } catch {
    return [];
  }
}

function writePendingDeletes(entries: PendingLayerDelete[]): void {
  try {
    if (entries.length === 0) globalThis.localStorage?.removeItem(PENDING_DELETES_KEY);
    else globalThis.localStorage?.setItem(PENDING_DELETES_KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable (private mode, quota): the delete still happened
    // locally; only the protection against the file coming back is lost.
  }
}

function notePendingLayerDelete(entry: PendingLayerDelete): void {
  const rest = readPendingDeletes().filter(
    (e) => !(e.volume_uuid === entry.volume_uuid && e.layer_id === entry.layer_id)
  );
  writePendingDeletes([...rest, entry]);
}

/**
 * Forget a pending delete — the layer exists again under that id (the "new
 * layer" action calls this), or its cloud copy is known to be gone.
 */
export function clearPendingLayerDelete(volumeUuid: string, layerId: string): void {
  const all = readPendingDeletes();
  const rest = all.filter((e) => !(e.volume_uuid === volumeUuid && e.layer_id === layerId));
  if (rest.length !== all.length) writePendingDeletes(rest);
}

/** The layer ids pending delete per volume, as far as `providerType`'s listing is concerned. */
function pendingDeletesFor(providerType: string): Map<string, Set<string>> {
  const byVolume = new Map<string, Set<string>>();
  for (const entry of readPendingDeletes()) {
    if (entry.provider !== undefined && entry.provider !== providerType) continue;
    const ids = byVolume.get(entry.volume_uuid);
    if (ids) ids.add(entry.layer_id);
    else byVolume.set(entry.volume_uuid, new Set([entry.layer_id]));
  }
  return byVolume;
}

/** A volume deleted outright takes its tombstones with it (a re-import starts clean). */
async function dropPendingDeletesOfMissingVolumes(): Promise<void> {
  const all = readPendingDeletes();
  if (all.length === 0) return;
  const uuids = [...new Set(all.map((e) => e.volume_uuid))];
  const rows = await db.volumes.bulkGet(uuids);
  const missing = new Set(uuids.filter((_, i) => !rows[i]));
  if (missing.size === 0) return;
  // Re-read: an entry may have been added while the lookup was in flight.
  writePendingDeletes(readPendingDeletes().filter((e) => !missing.has(e.volume_uuid)));
}

/**
 * A listed file that was downloaded and turned out NOT to be a layer of the
 * volume its name points at: its pages are not the volume's (`fitToVolume`). Layer files
 * are recognised by filename shape alone (`classifyMokuroSidecar`), so
 * `Vol 1.5.mokuro` with no `Vol 1.5.cbz` beside it reads as layer "5" of
 * `Vol 1` while really being the leftover primary sidecar of a removed volume,
 * or a manual copy. Making a row of it would be worse than showing garbage:
 * the row's `cloud` stamp is what lets a volume delete or rename sweep the
 * file along (`getSweepableCloudFilesForVolume`).
 *
 * With no row to carry a stamp, "no row → pull" would download the file again
 * on every listing, so the verdict is remembered here — for that exact file
 * (provider + listing stamp) against that exact page count. Either one moving
 * earns the file another look. Persisted like the pending deletes above; an
 * entry leaves with its volume.
 */
interface RejectedLayerFile {
  volume_uuid: string;
  layer_id: string;
  provider: string;
  /** The volume's `page_count` the file was weighed against. */
  page_count: number;
  size?: number;
  modified?: number;
  /**
   * The rule set that reached the verdict ({@link REJECTION_RULE}). A verdict
   * is only as good as its rule: entries written before short files were
   * aligned by image path (no `rule`) refused every engine file with a failed
   * page, and would keep refusing it — unchanged file, unchanged page count —
   * for as long as the browser profile lives.
   */
  rule?: number;
  /**
   * Refused on the page count ALONE, because the volume's pages were not on
   * this device to align a short file against (a metadata-only row). Stands
   * while that is still so; once the volume is installed the file is owed the
   * full look.
   */
  count_only?: true;
}

/** Bump when the acceptance rule changes in a way that could turn a refusal into a row. */
const REJECTION_RULE = 2;

const REJECTED_FILES_KEY = 'layer-sync:rejected-files';

function readRejectedFiles(): RejectedLayerFile[] {
  try {
    const raw = globalThis.localStorage?.getItem(REJECTED_FILES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RejectedLayerFile =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as RejectedLayerFile).volume_uuid === 'string' &&
        typeof (e as RejectedLayerFile).layer_id === 'string' &&
        typeof (e as RejectedLayerFile).provider === 'string' &&
        typeof (e as RejectedLayerFile).page_count === 'number'
    );
  } catch {
    return [];
  }
}

function writeRejectedFiles(entries: RejectedLayerFile[]): void {
  try {
    if (entries.length === 0) globalThis.localStorage?.removeItem(REJECTED_FILES_KEY);
    else globalThis.localStorage?.setItem(REJECTED_FILES_KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable: the file is still rejected, just re-read next time.
  }
}

function sameRejectedSlot(a: RejectedLayerFile, b: RejectedLayerFile): boolean {
  return a.volume_uuid === b.volume_uuid && a.layer_id === b.layer_id && a.provider === b.provider;
}

function rejectionOf(
  row: VolumeMetadata,
  listed: ListedLayerFile,
  providerType: string
): RejectedLayerFile {
  return {
    volume_uuid: row.volume_uuid,
    layer_id: listed.layerId,
    provider: providerType,
    page_count: row.page_count,
    ...stampOf(listed.file),
    rule: REJECTION_RULE,
    ...(isVolumeInstalled(row) ? {} : { count_only: true as const })
  };
}

/**
 * Already weighed against this page count and found wanting, and unchanged
 * since — by the rule in force, with at least as much in hand as now?
 */
function isKnownMismatch(candidate: RejectedLayerFile): boolean {
  return readRejectedFiles().some(
    (e) =>
      sameRejectedSlot(e, candidate) &&
      e.rule === REJECTION_RULE &&
      // A count-only verdict says nothing once there are pages to align against.
      !(e.count_only && !candidate.count_only) &&
      e.page_count === candidate.page_count &&
      // The same leniency as `cloudCopyMoved`: a side that knows no size/mtime
      // cannot say the file moved.
      !(e.size !== undefined && candidate.size !== undefined && e.size !== candidate.size) &&
      !(
        e.modified !== undefined &&
        candidate.modified !== undefined &&
        e.modified !== candidate.modified
      )
  );
}

function noteRejectedFile(entry: RejectedLayerFile): void {
  writeRejectedFiles([...readRejectedFiles().filter((e) => !sameRejectedSlot(e, entry)), entry]);
}

function clearRejectedFile(entry: RejectedLayerFile): void {
  const all = readRejectedFiles();
  const rest = all.filter((e) => !sameRejectedSlot(e, entry));
  if (rest.length !== all.length) writeRejectedFiles(rest);
}

async function dropRejectedFilesOfMissingVolumes(): Promise<void> {
  const all = readRejectedFiles();
  if (all.length === 0) return;
  const uuids = [...new Set(all.map((e) => e.volume_uuid))];
  const rows = await db.volumes.bulkGet(uuids);
  const missing = new Set(uuids.filter((_, i) => !rows[i]));
  if (missing.size === 0) return;
  writeRejectedFiles(readRejectedFiles().filter((e) => !missing.has(e.volume_uuid)));
}

function cloudCopyMoved(row: VolumeOcrLayer, file: LayerFileStamp): boolean {
  const listed = stampOf(file);
  const own = row.cloud;
  if (!own) return true;
  if (own.size !== undefined && listed.size !== undefined && own.size !== listed.size) return true;
  if (
    own.modified !== undefined &&
    listed.modified !== undefined &&
    listed.modified > own.modified
  ) {
    return true;
  }
  return false;
}

function editedSinceSync(row: VolumeOcrLayer): boolean {
  if (!row.cloud) return true;
  return row.updated_at > row.cloud.synced_at;
}

/**
 * A row that came out of a downloaded archive and has not been touched since
 * (`VolumeOcrLayer.passive_at`). Its `updated_at` is the download time, not an
 * edit time, so it must never be weighed against a cloud mtime.
 */
function isPassiveSnapshot(
  row: Pick<VolumeOcrLayer, 'cloud' | 'passive_at' | 'updated_at'>
): boolean {
  return !row.cloud && row.passive_at !== undefined && row.passive_at === row.updated_at;
}

/**
 * Should this listed file replace the local row? No row → yes. A passive
 * snapshot → yes, whatever the mtimes say. Stamps equal → no. Cloud moved and
 * the row is untouched since its sync → yes. Both moved → the cloud copy wins
 * only when its mtime is newer than the local edit.
 */
export function layerNeedsPull(
  row: VolumeOcrLayer | undefined,
  file: LayerFileStamp,
  providerType: string
): boolean {
  if (!row || isPassiveSnapshot(row)) return true;
  if (row.cloud && row.cloud.provider !== providerType) return !editedSinceSync(row);
  if (!cloudCopyMoved(row, file)) return false;
  if (!editedSinceSync(row)) return true;
  const cloudMtime = file.modifiedTimeProvisional ? undefined : Date.parse(file.modifiedTime);
  if (cloudMtime === undefined || !Number.isFinite(cloudMtime)) return false;
  return cloudMtime > Date.parse(row.updated_at);
}

/**
 * Should the local row be uploaded? Only when it changed since its last sync
 * with THIS provider (or was never synced) and the cloud copy is not newer.
 * A passive snapshot always loses to a listed file (`layerNeedsPull`), so it
 * is pushed only where the cloud has no such layer at all. An untouched
 * `updated-ocr` row is never pushed (`isUntouchedUpdatedOcr`).
 */
export function layerNeedsPush(
  row: VolumeOcrLayer,
  file: LayerFileStamp | undefined,
  providerType: string
): boolean {
  // The cloud's own primary sidecar, mirrored for an edited volume by the OCR
  // upgrade: pushing it would publish the primary a second time as a layer.
  if (isUntouchedUpdatedOcr(row)) return false;
  if (row.cloud && row.cloud.provider === providerType && !editedSinceSync(row)) return false;
  if (!file) return true;
  return !layerNeedsPull(row, file, providerType);
}

function providerIsWritable(provider: SyncProvider): boolean {
  return provider.getStatus().isReadOnly !== true;
}

/** Same key every "which row is this cloud file" question uses. */
function rowKey(volumeTitle: string): string {
  return normalizeVolumeTitleKey(volumeTitle);
}

async function rowsInFolder(folderTitle: string): Promise<Map<string, VolumeMetadata>> {
  const rows = await volumesForFoldedSeriesTitle(folderTitle, normalizeSeriesKey);
  const byTitle = new Map<string, VolumeMetadata>();
  for (const row of rows) {
    if (row.isPlaceholder) continue;
    const key = rowKey(row.volume_title);
    if (!byTitle.has(key)) byTitle.set(key, row);
  }
  return byTitle;
}

async function gunzipBlob(blob: Blob): Promise<Blob | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).blob();
}

function isPageArray(value: unknown): value is Page[] {
  return (
    Array.isArray(value) &&
    value.every(
      (p) =>
        p &&
        typeof p === 'object' &&
        Array.isArray((p as Page).blocks) &&
        typeof (p as Page).img_width === 'number'
    )
  );
}

/** What a downloaded layer file held: its pages, and the server engine that says it made them. */
interface PulledLayerFile {
  pages: Page[];
  /** `servedEngineOf` the file: set only for a server's OCR output, never for pushed edits. */
  engine?: string;
}

/** Decode one layer file's bytes into DB-shaped pages; null when unusable (a warning only when it throws). */
async function decodeLayerBlob(
  blob: Blob,
  gz: boolean,
  label: string
): Promise<PulledLayerFile | null> {
  try {
    if (gz) {
      const plain = await gunzipBlob(blob);
      if (!plain) return null;
      blob = plain;
    }
    const json = JSON.parse(await blob.text()) as { pages?: unknown };
    if (!isPageArray(json.pages)) return null;
    // DB shape: `cumulativeChars` is derived, never stored.
    const pages = json.pages.map((p) => {
      const { cumulativeChars: _c, ...page } = p as Page & { cumulativeChars?: number };
      return page;
    });
    const engine = servedEngineOf(json);
    return { pages, ...(engine ? { engine } : {}) };
  } catch (error) {
    console.warn(`[layer-sync] could not read '${label}':`, error);
    return null;
  }
}

/** Download + decode one listed layer file; null when unusable. */
async function readLayerFile(
  provider: SyncProvider,
  listed: ListedLayerFile
): Promise<PulledLayerFile | null> {
  let blob: Blob;
  try {
    blob = await provider.downloadFile(listed.file);
  } catch (error) {
    console.warn(`[layer-sync] could not read '${listed.file.path}':`, error);
    return null;
  }
  return decodeLayerBlob(blob, listed.gz, listed.file.path);
}

/**
 * The pulled pages as one page per page of the volume, or null when they
 * cannot be a layer of it. The same count is taken as it is; a SHORT file — an
 * engine run that dropped the pages it failed on — is put back in step by image
 * path (`alignLayerPages`), which needs the volume's own pages: only an
 * installed volume has them, so a metadata-only row can take nothing but an
 * exact count.
 */
async function fitToVolume(row: VolumeMetadata, pages: Page[]): Promise<Page[] | null> {
  if (pages.length === row.page_count) return pages;
  if (pages.length > row.page_count || !isVolumeInstalled(row)) return null;
  const primary = await db.volume_ocr.get(row.volume_uuid);
  if (!primary || primary.pages.length !== row.page_count) return null;
  return alignLayerPages(pages, primary.pages);
}

async function pullOne(
  provider: SyncProvider,
  listed: ListedLayerFile,
  row: VolumeMetadata,
  existing: VolumeOcrLayer | undefined
): Promise<boolean> {
  // The one gate every pulled file passes on its way to becoming a row: it
  // must plausibly be a layer OF THIS VOLUME, i.e. have the volume's page
  // count — or fewer pages that each name one of the volume's images, see
  // `fitToVolume`. (Not its `volume_uuid` — an engine's sidecar may carry another.)
  // A row that does not know its page count yet (a 0/0 index entry) cannot
  // vouch for anything; its layers arrive with the volume
  // (`pullLayersForVolume` after the download), when the count is real.
  if (!(row.page_count > 0)) {
    console.debug(
      `[layer-sync] not pulling '${listed.file.path}': page count of '${row.volume_title}' unknown`
    );
    return false;
  }
  const rejection = rejectionOf(row, listed, provider.type);
  if (isKnownMismatch(rejection)) return false;
  const pulled = await readLayerFile(provider, listed);
  if (!pulled) return false;
  const stored = await storePulledLayer(row, listed.layerId, pulled, existing, {
    provider: provider.type,
    stamp: stampOf(listed.file),
    label: listed.file.path
  });
  if (!stored) {
    noteRejectedFile(rejection);
    return false;
  }
  clearRejectedFile(rejection);
  return true;
}

/**
 * Turn a decoded layer file into this volume's row: fit it to the volume, file
 * it (a server's stamp makes it `ocr` of the engine the FILE names), stamp it
 * with where it came from. False — with the one log line a refused layer
 * leaves — when the pages cannot be a layer of this volume. Shared by the
 * listing pull and a deep link's manifest, so both file a layer identically.
 */
async function storePulledLayer(
  row: VolumeMetadata,
  layerId: string,
  pulled: PulledLayerFile,
  existing: VolumeOcrLayer | undefined,
  source: { provider: string; stamp: { size?: number; modified?: number }; label: string }
): Promise<boolean> {
  const read = pulled.pages;
  const pages = await fitToVolume(row, read);
  if (!pages) {
    // Once per file version (the verdict is remembered), and the only trace a
    // refused layer leaves anywhere — so a final verdict is not logged at debug
    // level, where nobody wondering why a layer never arrived would see it. A
    // count-only one is a deferral (the download takes another look), not news.
    const countOnly = !isVolumeInstalled(row);
    const log = countOnly ? console.debug : console.warn;
    log(
      `[layer-sync] '${source.label}' is not a layer of '${row.volume_title}': ` +
        `${read.length} page(s), the volume has ${row.page_count}` +
        (countOnly ? ' (not on this device, so a short file cannot be aligned yet)' : '')
    );
    return false;
  }
  if (pages !== read) {
    console.log(
      `[layer-sync] '${source.label}' has ${read.length} of ${row.page_count} page(s): ` +
        `the missing ${row.page_count - read.length} are blank in this layer`
    );
  }
  const now = new Date().toISOString();
  // A row a cloud vouches for that was filed as a person's `edit` before the
  // stamp was read (or while its id was unknown) and turns out to be a server's
  // OCR is re-filed as what it is. Never a row made here by hand, and never one
  // already attributed to an engine.
  const misfiled =
    existing?.kind === 'edit' && !existing.engine && !!existing.cloud && !!pulled.engine;
  const kind = misfiled
    ? ('ocr' as const)
    : (existing?.kind ?? layerKindForId(layerId, pulled.engine));
  const layer: VolumeOcrLayer = {
    volume_uuid: row.volume_uuid,
    layer_id: layerId,
    name: existing?.name ?? layerNameForId(layerId),
    kind,
    // The engine the FILE names, not the layer's id: a server calls its
    // generations what it likes (`hayai-nova-ctd` is still hayai-nova).
    ...(existing?.engine
      ? { engine: existing.engine }
      : kind === 'ocr'
        ? { engine: pulled.engine ?? layerId }
        : {}),
    created_at: existing?.created_at ?? now,
    updated_at: now,
    cloud: { provider: source.provider, ...source.stamp, synced_at: now }
  };
  await putLayerWithPages(db, { ...layer, pages });
  return true;
}

/** The `.mokuro.gz` copies of a listed layer — what a plain push leaves shadowed. */
function gzCopiesOf(listed: ListedLayerFile | undefined): CloudFileMetadata[] {
  return (listed?.copies ?? []).filter((c) => c.gz).map((c) => c.file);
}

/**
 * Remove the `.mokuro.gz` sibling(s) of a layer whose plain file is this
 * device's own. Best-effort by design: a failure changes nothing (the plain
 * file already wins every read), and because the sibling is then still listed,
 * the next push or listing comes back for it.
 */
async function removeGzSiblings(provider: SyncProvider, siblings: CloudFileMetadata[]) {
  for (const file of siblings) await deleteOneCopy(provider, file);
}

async function pushOne(
  provider: SyncProvider,
  folderTitle: string,
  stem: string,
  row: VolumeMetadata,
  planned: VolumeOcrLayer,
  gzSiblings: CloudFileMetadata[] = []
): Promise<boolean> {
  try {
    // The plan carries metadata only — it is drawn up for a whole listing, and
    // holding every pushable layer's pages until its turn in the pool would be
    // the library's OCR in memory. The pages are read here, one layer at a time.
    const layer = await getLayerWithPages(db, planned.volume_uuid, planned.layer_id);
    if (!layer) return false; // deleted since the plan
    const { totalChars } = buildPageCharCounts(layer.pages);
    const meta = buildMokuroMetadata({ ...row, character_count: totalChars }, layer.pages);
    const blob = new Blob([JSON.stringify(meta)], { type: 'application/json' });
    const path = `${folderTitle}/${layerSidecarName(stem, layer.layer_id)}`;
    const uploaded = await provider.uploadFile(path, blob);
    cacheManager
      .getCache(provider.type)
      ?.add?.(path, uploadCacheEntry(provider.type, path, blob.size, uploaded));
    const now = new Date().toISOString();
    await updateLayerMeta(db, layer.volume_uuid, layer.layer_id, {
      cloud: {
        provider: provider.type,
        size: uploaded.size ?? blob.size,
        ...(uploaded.modifiedTime ? { modified: isoToEpochSeconds(uploaded.modifiedTime) } : {}),
        synced_at: now
      }
    });
  } catch (error) {
    console.warn(`[layer-sync] could not upload layer '${planned.layer_id}' of '${stem}':`, error);
    return false;
  }
  // A push always writes the PLAIN name, so a layer that arrived as an
  // engine's `.mokuro.gz` would otherwise keep that file beside its successor
  // forever. Only once the plain copy is safely up, and never part of the
  // push's own verdict.
  await removeGzSiblings(provider, gzSiblings);
  return true;
}

/**
 * A row that arrived from a cloud while its id was not yet a known engine id
 * was filed as a manual `edit` under the title-cased slug ("Ppocr Manga"). Now
 * that the id is known, file it as what every other device will: that engine's
 * OCR, under the engine's name — unless the user renamed it. Metadata only and
 * `updated_at` untouched, so this is never an edit to push. Only rows a cloud
 * vouches for (`cloud`): a layer made here by hand is the user's own, whatever
 * its slug happens to be.
 */
async function refileKnownEngineRows(local: VolumeOcrLayer[]): Promise<void> {
  for (const layer of local) {
    if (layer.kind !== 'edit' || layer.engine || !layer.cloud) continue;
    if (layerKindForId(layer.layer_id) !== 'ocr') continue;
    const renamed = layer.name !== titleCasedLayerId(layer.layer_id);
    const changes = {
      kind: 'ocr' as const,
      engine: layer.layer_id,
      ...(renamed ? {} : { name: layerNameForId(layer.layer_id) })
    };
    await updateLayerMeta(db, layer.volume_uuid, layer.layer_id, changes);
    Object.assign(layer, changes);
  }
}

async function runPool<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  });
  await Promise.all(workers);
}

type Transfer =
  | { kind: 'pull'; listed: ListedLayerFile; row: VolumeMetadata; existing?: VolumeOcrLayer }
  | {
      kind: 'push';
      folderTitle: string;
      stem: string;
      row: VolumeMetadata;
      layer: VolumeOcrLayer;
      gzSiblings: CloudFileMetadata[];
    }
  /** A `.gz` left beside this device's own plain file (an earlier push could not remove it). */
  | { kind: 'tidy'; gzSiblings: CloudFileMetadata[] }
  /** A pending delete's retry: the file of a layer the user already deleted here. */
  | { kind: 'delete'; listed: ListedLayerFile; volumeUuid: string };

/**
 * What one folder of the listing needs transferred.
 *
 * Runs for every folder of every listing, so it must cost nothing where there
 * is nothing to do, and must never read a layer's PAGES: the decisions below
 * are all made on stamps, and a server that writes an engine sidecar per volume
 * lists a layer for every volume of the library. `volumesWithLayers` (one
 * keys-only read per listing, `runSync`) lets a folder with no listed layer
 * files skip even its `volumes` query unless one of those volumes could be
 * in it.
 */
async function planFolder(
  folderTitle: string,
  files: CloudFileMetadata[],
  layerFiles: ListedLayerFile[],
  providerType: ProviderType,
  writable: boolean,
  pendingDeletes: Map<string, Set<string>>,
  volumesWithLayers: Set<string>
): Promise<Transfer[]> {
  // Nothing listed, nothing local anywhere, no tombstone to retire: done.
  if (layerFiles.length === 0 && volumesWithLayers.size === 0 && pendingDeletes.size === 0) {
    return [];
  }
  const rows = await rowsInFolder(folderTitle);
  if (rows.size === 0) return [];
  // ONE indexed query for the whole folder, over metadata rows only.
  const withLayers = [...rows.values()]
    .map((row) => row.volume_uuid)
    .filter((uuid) => volumesWithLayers.has(uuid));
  const localByVolume = new Map<string, VolumeOcrLayer[]>();
  for (const meta of await listLayerMetasForVolumes(db, withLayers)) {
    const group = localByVolume.get(meta.volume_uuid);
    if (group) group.push(meta);
    else localByVolume.set(meta.volume_uuid, [meta]);
  }
  if (layerFiles.length === 0 && localByVolume.size === 0) {
    // Nothing to pull or push. A tombstone here is spent all the same — the
    // listing no longer shows its file (the rule the loop below applies).
    for (const row of rows.values()) {
      for (const layerId of pendingDeletes.get(row.volume_uuid) ?? []) {
        clearPendingLayerDelete(row.volume_uuid, layerId);
      }
    }
    return [];
  }
  const archives = archiveStemsOf(files);
  const transfers: Transfer[] = [];
  const listedByRow = new Map<string, Map<string, ListedLayerFile>>();
  for (const listed of layerFiles) {
    const row = rows.get(rowKey(listed.stem));
    if (!row) continue;
    let perRow = listedByRow.get(row.volume_uuid);
    if (!perRow) listedByRow.set(row.volume_uuid, (perRow = new Map()));
    perRow.set(listed.layerId, listed);
  }
  for (const row of rows.values()) {
    const archiveStem = archives.get(rowKey(row.volume_title));
    const local = localByVolume.get(row.volume_uuid) ?? [];
    await refileKnownEngineRows(local);
    const localById = new Map(local.map((l) => [l.layer_id, l]));
    const listed = listedByRow.get(row.volume_uuid) ?? new Map<string, ListedLayerFile>();
    const tombstoned = new Set<string>();
    for (const layerId of pendingDeletes.get(row.volume_uuid) ?? []) {
      // A row under that id again means it was re-created (new layer, import,
      // promote) — and a listing that no longer shows the file has nothing
      // left to pull back. Either way the tombstone is spent.
      if (localById.has(layerId) || !listed.has(layerId)) {
        clearPendingLayerDelete(row.volume_uuid, layerId);
      } else {
        tombstoned.add(layerId);
      }
    }
    for (const [layerId, file] of listed) {
      if (tombstoned.has(layerId)) {
        // Deleted here: never pulled back; removed as soon as the cloud allows.
        if (writable) transfers.push({ kind: 'delete', listed: file, volumeUuid: row.volume_uuid });
        continue;
      }
      const existing = localById.get(layerId);
      if (layerNeedsPull(existing, file.file, providerType)) {
        transfers.push({ kind: 'pull', listed: file, row, existing });
      }
    }
    if (!writable || archiveStem === undefined) continue;
    for (const layer of local) {
      const listedLayer = listed.get(layer.layer_id);
      const gzSiblings = gzCopiesOf(listedLayer);
      if (layerNeedsPush(layer, listedLayer?.file, providerType)) {
        transfers.push({ kind: 'push', folderTitle, stem: archiveStem, row, layer, gzSiblings });
      } else if (
        // The retry of a sibling delete that failed (here or on another
        // device): the plain file is listed and is the copy this row is in
        // sync with, so the `.gz` behind it is shadowed for good. A row that
        // never synced with this provider vouches for nothing.
        gzSiblings.length > 0 &&
        listedLayer &&
        !listedLayer.gz &&
        layer.cloud?.provider === providerType &&
        !layerNeedsPull(layer, listedLayer.file, providerType)
      ) {
        transfers.push({ kind: 'tidy', gzSiblings });
      }
    }
  }
  return transfers;
}

let inFlight: Promise<void> | null = null;
let queued: { cloudFilesMap: Map<string, CloudFileMetadata[]>; providerType: ProviderType } | null =
  null;

async function runSync(
  cloudFilesMap: Map<string, CloudFileMetadata[]>,
  providerType: ProviderType
): Promise<{ pulled: number; pushed: number }> {
  const result = { pulled: 0, pushed: 0 };
  if (cloudFilesMap.size === 0) return result;
  const provider = providerManager.getActiveProvider();
  if (!provider || provider.type !== providerType) return result;
  const writable = providerIsWritable(provider);

  await dropPendingDeletesOfMissingVolumes().catch(() => {});
  await dropRejectedFilesOfMissingVolumes().catch(() => {});
  const pendingDeletes = pendingDeletesFor(providerType);
  const volumesWithLayers = await listVolumeUuidsWithLayers(db);

  const layerFiles = collectLayerFiles(cloudFilesMap);
  const byFolder = new Map<string, ListedLayerFile[]>();
  for (const listed of layerFiles) {
    const group = byFolder.get(listed.folderTitle);
    if (group) group.push(listed);
    else byFolder.set(listed.folderTitle, [listed]);
  }

  const transfers: Transfer[] = [];
  for (const files of cloudFilesMap.values()) {
    const first = files.find((f) => normalizeCloudPath(f.path).includes('/'));
    if (!first) continue;
    const folderTitle = normalizeCloudPath(first.path).split('/')[0];
    try {
      transfers.push(
        ...(await planFolder(
          folderTitle,
          files,
          byFolder.get(folderTitle) ?? [],
          providerType,
          writable,
          pendingDeletes,
          volumesWithLayers
        ))
      );
    } catch (error) {
      console.warn(`[layer-sync] could not plan '${folderTitle}':`, error);
    }
  }

  await runPool(transfers, MAX_CONCURRENT_LAYER_TRANSFERS, async (t) => {
    // The account can change while transfers run: stop, never cross-account.
    if (providerManager.getActiveProvider()?.type !== providerType) return;
    if (t.kind === 'delete') {
      // A failure keeps the tombstone: the file stays hidden, the next listing retries.
      if (await deleteListedLayerFile(provider, t.listed)) {
        clearPendingLayerDelete(t.volumeUuid, t.listed.layerId);
      }
    } else if (t.kind === 'tidy') {
      await removeGzSiblings(provider, t.gzSiblings);
    } else if (t.kind === 'pull') {
      if (await pullOne(provider, t.listed, t.row, t.existing)) result.pulled++;
    } else if (await pushOne(provider, t.folderTitle, t.stem, t.row, t.layer, t.gzSiblings)) {
      result.pushed++;
    }
  });
  if (result.pulled || result.pushed) {
    console.log(`[layer-sync] pulled ${result.pulled}, pushed ${result.pushed} layer file(s)`);
  }
  return result;
}

/**
 * Pull + push every layer the listing shows, for the volumes this device has
 * rows for. Coalesces like `refreshSeriesIndexes`: a listing arriving mid-run
 * runs once after it. Never rejects.
 */
export function syncLayersFromListing(
  cloudFilesMap: Map<string, CloudFileMetadata[]>,
  providerType: ProviderType
): Promise<void> {
  if (inFlight) {
    queued = { cloudFilesMap, providerType };
    return inFlight;
  }
  inFlight = (async () => {
    try {
      let current: typeof queued = { cloudFilesMap, providerType };
      while (current) {
        try {
          await runSync(current.cloudFilesMap, current.providerType);
        } catch (error) {
          console.warn('[layer-sync] run failed:', error);
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

/** Group the provider cache's flat file list by folder, the listing shape the sync takes. */
export function listingFromCache(providerType: ProviderType): Map<string, CloudFileMetadata[]> {
  const map = new Map<string, CloudFileMetadata[]>();
  const files = cacheManager.getCache(providerType)?.getAllFiles() ?? [];
  for (const file of files as CloudFileMetadata[]) {
    const folder = normalizeCloudPath(file.path).split('/')[0];
    if (!folder) continue;
    const group = map.get(folder);
    if (group) group.push(file);
    else map.set(folder, [file]);
  }
  return map;
}

/**
 * Pull the layers of ONE volume from the cached listing — for a volume that
 * was just downloaded, so its engine layers appear without a second listing.
 * Returns how many were pulled. Never rejects.
 */
export async function pullLayersForVolume(
  volumeUuid: string,
  providerType: ProviderType
): Promise<number> {
  try {
    const row = await db.volumes.get(volumeUuid);
    if (!row || row.isPlaceholder) return 0;
    const provider = providerManager.getActiveProvider();
    if (!provider || provider.type !== providerType) return 0;
    const listing = listingFromCache(providerType);
    const seriesKey = normalizeSeriesKey(row.series_title);
    const titleKey = rowKey(row.volume_title);
    const mine = collectLayerFiles(listing).filter(
      (l) => normalizeSeriesKey(l.folderTitle) === seriesKey && rowKey(l.stem) === titleKey
    );
    const tombstoned = pendingDeletesFor(providerType).get(volumeUuid);
    let pulled = 0;
    await runPool(mine, MAX_CONCURRENT_LAYER_TRANSFERS, async (listed) => {
      const existing = await getLayerMeta(db, volumeUuid, listed.layerId);
      // Deleted here and not re-created: a fresh download must not bring it back.
      if (!existing && tombstoned?.has(listed.layerId)) return;
      if (!layerNeedsPull(existing, listed.file, providerType)) return;
      if (await pullOne(provider, listed, row, existing)) pulled++;
    });
    return pulled;
  } catch (error) {
    console.warn('[layer-sync] pull for volume failed:', error);
    return 0;
  }
}

/** A layer file already fetched from somewhere that is not a listing — a deep link's manifest. */
export interface FetchedLayerFile {
  layerId: string;
  /** The bytes are gzipped (`<stem>.<id>.mokuro.gz`). */
  gz: boolean;
  blob: Blob;
  /** Where it came from (its URL): names the file in every warning. */
  label: string;
  /** The source's own size of the file (the `.gz` size for a gzipped one); else the blob's. */
  size?: number;
  /** ISO modification time the source stamped; absent = unknown, and stamped size-only. */
  modifiedTime?: string;
}

/**
 * Import layer files that arrived with a volume from a non-listing source,
 * exactly as a listing's pull would: same tombstones (as `source` sees them),
 * same "does it replace the row" rule (`layerNeedsPull` against the source's
 * stamp), same decoding, fitting and filing (`storePulledLayer`), and the row
 * is stamped `cloud: { provider: source, … }` so a later listing of the same
 * file on a real provider takes it over rather than pushing it back. No
 * rejection memory: that only spares a listing from re-downloading a refused
 * file every time, and these are already downloaded.
 *
 * Returns how many were stored. Never rejects; each file that fails is one
 * warning naming it, and the rest still import.
 */
export async function importFetchedLayers(
  volumeUuid: string,
  source: string,
  files: FetchedLayerFile[]
): Promise<number> {
  let stored = 0;
  try {
    const row = await db.volumes.get(volumeUuid);
    if (!row || row.isPlaceholder || !(row.page_count > 0)) return 0;
    const tombstoned = pendingDeletesFor(source).get(volumeUuid);
    for (const fetched of files) {
      try {
        const stamp: LayerFileStamp = {
          size: fetched.size ?? fetched.blob.size,
          modifiedTime: fetched.modifiedTime ?? '',
          modifiedTimeProvisional: !fetched.modifiedTime
        };
        const existing = await getLayerMeta(db, volumeUuid, fetched.layerId);
        if (!existing && tombstoned?.has(fetched.layerId)) continue;
        if (!layerNeedsPull(existing, stamp, source)) continue;
        const pulled = await decodeLayerBlob(fetched.blob, fetched.gz, fetched.label);
        if (!pulled) {
          console.warn(`[layer-sync] '${fetched.label}' is not a readable OCR layer; skipped`);
          continue;
        }
        const ok = await storePulledLayer(row, fetched.layerId, pulled, existing, {
          provider: source,
          stamp: stampOf(stamp),
          label: fetched.label
        });
        if (ok) stored++;
      } catch (error) {
        console.warn(`[layer-sync] could not import '${fetched.label}':`, error);
      }
    }
  } catch (error) {
    console.warn('[layer-sync] importing fetched layers failed:', error);
  }
  return stored;
}

/**
 * What a layer's cloud delete established. `'gone'`: nothing is left that a
 * listing could pull back — the file was deleted, the layer never reached a
 * cloud, or a listing covering its volume shows no such file. `'unconfirmed'`:
 * a copy may survive (offline, read-only, synced with another provider, the
 * request failed, no listing to consult) — the caller must leave a tombstone.
 */
export type CloudLayerDeleteOutcome = 'gone' | 'unconfirmed';

async function deleteOneCopy(provider: SyncProvider, file: CloudFileMetadata): Promise<boolean> {
  try {
    await provider.deleteFile(file);
    cacheManager.getCache(provider.type)?.removeById?.(file.fileId);
    return true;
  } catch (error) {
    console.warn(`[layer-sync] could not delete '${file.path}':`, error);
    return false;
  }
}

/**
 * Delete EVERY listed copy of a layer (`.mokuro` and `.mokuro.gz`). True only
 * when all of them went: one survivor is enough for the next listing to read
 * the layer back, so the caller must keep its tombstone. A failed copy never
 * spares the others — each one removed is one less to retry.
 */
async function deleteListedLayerFile(
  provider: SyncProvider,
  listed: ListedLayerFile
): Promise<boolean> {
  let allGone = true;
  for (const copy of listed.copies) {
    if (!(await deleteOneCopy(provider, copy.file))) allGone = false;
  }
  return allGone;
}

/**
 * Remove one layer's cloud file(s) ahead of deleting its row — every listed
 * copy of it, `.mokuro` and `.mokuro.gz` alike. Only ever the copies
 * on the provider the row was synced with (a same-id file on a provider this
 * row never reconciled with is somebody else's layer, not ours to delete).
 * Never rejects; reports whether the copy is known to be gone.
 */
export async function deleteLayerFileInCloud(
  row: VolumeMetadata,
  layer: Pick<VolumeOcrLayer, 'layer_id' | 'cloud'> &
    Partial<Pick<VolumeOcrLayer, 'passive_at' | 'updated_at'>>
): Promise<CloudLayerDeleteOutcome> {
  try {
    // A passive snapshot has no stamp yet, but it came out of a cloud archive
    // whose sidecar is most likely still beside it.
    const passive = isPassiveSnapshot({ ...layer, updated_at: layer.updated_at ?? '' });
    if (!layer.cloud && !passive) return 'gone';
    const provider = providerManager.getActiveProvider();
    if (!provider) return 'unconfirmed';
    if (layer.cloud && layer.cloud.provider !== provider.type) return 'unconfirmed';
    const seriesKey = normalizeSeriesKey(row.series_title);
    const titleKey = rowKey(row.volume_title);
    const listing = listingFromCache(provider.type);
    const listed = collectLayerFiles(listing).find(
      (l) =>
        normalizeSeriesKey(l.folderTitle) === seriesKey &&
        rowKey(l.stem) === titleKey &&
        l.layerId === layer.layer_id
    );
    if (!listed) {
      // "Not listed" is only proof from a cache that covers this volume — an
      // unloaded or stale cache shows nothing for every file.
      const covered = [...listing.entries()].some(
        ([folder, files]) =>
          normalizeSeriesKey(folder) === seriesKey &&
          [...archiveStemsOf(files).values()].some((stem) => rowKey(stem) === titleKey)
      );
      return covered ? 'gone' : 'unconfirmed';
    }
    if (!providerIsWritable(provider)) return 'unconfirmed';
    return (await deleteListedLayerFile(provider, listed)) ? 'gone' : 'unconfirmed';
  } catch (error) {
    console.warn('[layer-sync] could not delete the cloud layer file:', error);
    return 'unconfirmed';
  }
}

/** One layer as a backup serialized and uploaded it (`generateVolumeSidecarsFromDb`). */
export interface LayerUploadSnapshot {
  layerId: string;
  /** The row's `updated_at` at the moment its pages were read for the upload. */
  updatedAt: string;
  /** Bytes uploaded. */
  size: number;
}

/**
 * After a backup uploaded a volume's layer files beside its archive, record
 * what the provider now holds — per SNAPSHOT, never from a fresh read of the
 * rows: the upload takes long enough to edit a layer under it, and a row
 * stamped "synced now" with such an edit inside would never be pushed, then be
 * overwritten by the stale upload on the next listing.
 *
 * - Row unchanged since the read → in sync as of now.
 * - Row edited since → still stamped with the uploaded size (so the listed
 *   file reads as our own upload, not as a newer foreign copy that would win
 *   on mtime), but synced only as of the snapshot: `editedSinceSync` stays
 *   true and the next listing pushes the edit.
 * - A layer that is not in the snapshot was not uploaded: left alone.
 *
 * No mtime either way (the next listing supplies it — a stampless mtime
 * compares size only). Never rejects.
 */
export async function stampLayersSynced(
  volumeUuid: string,
  providerType: ProviderType,
  uploaded: LayerUploadSnapshot[]
): Promise<void> {
  try {
    const now = new Date().toISOString();
    for (const snapshot of uploaded) {
      // Read-compare-write in one transaction: an edit cannot slip in between.
      await patchLayerMeta(db, volumeUuid, snapshot.layerId, (row) => ({
        cloud: {
          provider: providerType,
          size: snapshot.size,
          synced_at: row.updated_at === snapshot.updatedAt ? now : snapshot.updatedAt
        }
      }));
    }
  } catch (error) {
    console.warn('[layer-sync] could not stamp layers after backup:', error);
  }
}

/**
 * `deleteLayerFileInCloud` by ids: reads the row and the layer's stamp itself,
 * and leaves the pending-delete tombstone when the copy may survive — so the
 * caller can delete the row right away (no blocking on being online) without
 * the next listing pulling the layer back. Never rejects.
 */
export async function deleteCloudLayerFile(
  volumeUuid: string,
  layerId: string
): Promise<CloudLayerDeleteOutcome> {
  let provider: string | undefined;
  try {
    const [row, layer] = await Promise.all([
      db.volumes.get(volumeUuid),
      getLayerMeta(db, volumeUuid, layerId)
    ]);
    if (!row || !layer) return 'gone';
    provider = layer.cloud?.provider ?? providerManager.getActiveProvider()?.type;
    const outcome = await deleteLayerFileInCloud(row, layer);
    if (outcome === 'gone') clearPendingLayerDelete(volumeUuid, layerId);
    else notePendingLayerDelete({ volume_uuid: volumeUuid, layer_id: layerId, provider });
    return outcome;
  } catch (error) {
    console.warn('[layer-sync] could not delete the cloud layer file:', error);
    notePendingLayerDelete({ volume_uuid: volumeUuid, layer_id: layerId, provider });
    return 'unconfirmed';
  }
}
