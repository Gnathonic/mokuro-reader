import { db } from '$lib/catalog/db';
import { accountCanAddFiles, canPublishCurated } from '$lib/util/sync/account-capabilities';
import {
  deleteLayerRows,
  getLayerMeta,
  getLayerPages,
  getLayerWithPages,
  layerTables,
  listLayerIds,
  listLayerMetasForVolumes,
  listVolumeUuidsWithLayers,
  patchLayerMeta,
  putLayerWithPages,
  updateLayerMeta
} from '$lib/catalog/layer-store';
import type { Page, VolumeMetadata, VolumeOcrLayer } from '$lib/types';
import {
  isCorrectionsLayerId,
  layerKindForId,
  layerNameForId,
  servedEngineOf,
  titleCasedLayerId
} from '$lib/reader/edit/layers';
import { alignLayerPages } from '$lib/reader/edit/layer-page-align';
import {
  CURATED_LAYER_ID,
  EDIT_LAYER_ID,
  isCuratedLayerId,
  isPersonalLayerId
} from '$lib/reader/edit/layer-names';
import { editLayerEpoch } from '$lib/reader/edit/edit-layer-epoch';
import { isCloudModelOutput } from '$lib/reader/edit/layer-kind';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import { buildPageCharCounts } from '$lib/catalog/page-char-counts';
import {
  layerIdStaysLocal,
  layerStaysLocal,
  pulledFromCompilingServer,
  personalLayerAccount,
  syncedForOtherAccount,
  type LayerTarget
} from '$lib/catalog/mokuro-hash';
import { buildLayerMokuroMetadata } from '$lib/util/mokuro-metadata';
import { editBaseSeal } from '$lib/catalog/ocr-provenance';
import { cacheManager } from '$lib/util/sync/cache-manager';
import { uploadCacheEntry } from '$lib/util/sync/cloud-cache-interface';
import {
  ProviderError,
  type CloudFileMetadata,
  type ProviderStatus,
  type ProviderType,
  type SyncProvider
} from '$lib/util/sync/provider-interface';
import { providerManager } from '$lib/util/sync/provider-manager';
import { freshGateStatus, refreshGates } from '$lib/util/sync/identity-gates';
import {
  cbzStemsOf,
  classifyMokuroSidecar,
  isCbzFile,
  layerOwnerArchive,
  layerSidecarName
} from '$lib/util/sync/syncable-file';
import { naturalSort } from '$lib/util/natural-sort';
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
 * - The `.mokuro` a push writes is upstream format (`buildLayerMokuroMetadata`);
 *   the layer's kind/name are inferred from the id on the other side, never
 *   embedded — except that a layer of kind `edit` carries the top-level
 *   `edited` block (bunko design 0.8 D4: human corrections, not model output).
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
    // Every archive spelling: two archives that fold alike are two volumes.
    const archiveSpellings = new Set(
      oneDeep
        .map((f) => basename(f.path))
        .filter(isCbzFile)
        .map((name) => name.slice(0, -4))
    );
    const cbzStems = cbzStemsOf(oneDeep.map((f) => basename(f.path)));
    const seen = new Map<string, ListedLayerFile>();
    for (const file of oneDeep) {
      const cls = classifyMokuroSidecar(basename(file.path), cbzStems);
      if (cls.kind !== 'layer') continue;
      // ONE owner per layer file, the same one `unified-cloud-manager.ts`
      // sweeps it with: the archive spelled exactly like the stem, else the
      // naturalSort-first of those that fold alike (rule v1 #6) — never the
      // archive the listing happened to return last.
      const stem = layerOwnerArchive(cls.stem, archiveSpellings) ?? cls.stem;
      const key = `${stem}\u0000${cls.layerId}`;
      const existing = seen.get(key);
      const copies = [...(existing?.copies ?? []), { file, gz: cls.gz }];
      if (existing && !existing.gz) {
        existing.copies = copies; // plain beats gz
        continue;
      }
      seen.set(key, {
        folderTitle,
        stem,
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
  /**
   * A personal layer's (`edit`, `edit-<n>`): the `accountScope` whose file it
   * is. bunko serves each account its own copy at one path, so another
   * account's listing neither retries, hides nor spends it. Absent = any.
   */
  account?: string;
  /**
   * Left by Unpublish (`unpublishCuratedLayer`): the one tombstone whose retry
   * may delete the shared `curated` file. Any other tombstone of a layer that
   * stays local by its id only hides the file here (`canDeleteLayer`).
   */
  unpublish?: true;
  /**
   * With `unpublish`: the stamp of the copy the Unpublish meant to remove. A
   * listed file that moved since is another editor's newer publish — the
   * tombstone is spent, not retried against it.
   */
  file?: { size?: number; modified?: number };
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

/**
 * A layer row was deleted here: keep its cloud copy (if any) from being pulled
 * back, and remove it when the provider allows (the next listing). Also used
 * by the OCR upgrade, which drops snapshots its new primary made stale.
 */
export function notePendingLayerDelete(entry: PendingLayerDelete): void {
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

/**
 * The layer ids pending delete per volume, as far as `providerType`'s listing
 * (under `account`, the active `accountScope`) is concerned.
 */
function pendingDeletesFor(providerType: string, account?: string): Map<string, Set<string>> {
  const byVolume = new Map<string, Set<string>>();
  for (const entry of readPendingDeletes()) {
    if (entry.provider !== undefined && entry.provider !== providerType) continue;
    if (entry.account && account && entry.account !== account) continue;
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
 * only when its mtime is newer than the local edit. A row synced with another
 * provider, or (a personal layer) under another account (`account` = the
 * active `accountScope`), is replaced only while it holds no unsynced edit:
 * those already sit in the other copy.
 */
export function layerNeedsPull(
  row: VolumeOcrLayer | undefined,
  file: LayerFileStamp,
  providerType: string,
  account?: string
): boolean {
  if (!row || isPassiveSnapshot(row)) return true;
  if (row.cloud && row.cloud.provider !== providerType) return !editedSinceSync(row);
  if (syncedForOtherAccount(row, account)) return !editedSinceSync(row);
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
 * `updated-ocr` row is never pushed (`isUntouchedUpgradeLayer`).
 */
export function layerNeedsPush(
  row: VolumeOcrLayer,
  file: LayerFileStamp | undefined,
  providerType: string,
  /** What the provider takes (bunko, the edit-layer gate): see `layerStaysLocal`. */
  target: LayerTarget = { serverCompilesMetadata: false },
  /** The active `accountScope`: a personal row of another account is not ours to push. */
  account?: string
): boolean {
  // The cloud's own primary sidecar, mirrored for an edited volume by the OCR
  // upgrade (pushing it would publish the primary a second time as a layer),
  // the shared `curated` layer, an `edit` layer the server would share, or the
  // editor's `original` / a case merge's `curated-<n>` on a server that
  // compiles its metadata.
  if (layerStaysLocal(row, { provider: providerType, ...target })) return false;
  if (syncedForOtherAccount(row, account)) return false;
  if (row.cloud && row.cloud.provider === providerType && !editedSinceSync(row)) return false;
  if (!file) return true;
  return !layerNeedsPull(row, file, providerType, account);
}

/**
 * May this account write `layerId`'s file on this provider? Never when it is
 * read-only. An account's own `edit` layer on a bunko that keeps it per
 * account needs nothing more: every role that may write progress may write
 * its own overlay (and `isReadOnly` = neither progress nor files). Any other
 * layer is a library file: a progress-only account (bunko `registered`) would
 * be refused per file on every listing, so it only pulls those.
 */
export function canPushLayer(
  status: Pick<
    ProviderStatus,
    'isReadOnly' | 'canAddFiles' | 'serverCompilesMetadata' | 'editLayerSync'
  >,
  layerId: string
): boolean {
  if (status.isReadOnly === true) return false;
  if (
    isPersonalLayerId(layerId) &&
    status.serverCompilesMetadata === true &&
    status.editLayerSync === 'push'
  ) {
    return true;
  }
  return accountCanAddFiles(status);
}

/** What one listing's plan needs of the provider, read once per run. */
interface PushGate {
  status: ProviderStatus;
  target: LayerTarget;
  /** `personalLayerAccount`: stamped on (and compared with) personal rows. */
  account?: string;
  /**
   * Volumes whose `curated` file an Unpublish still has to delete
   * (`PendingLayerDelete.unpublish`) → the stamp of the copy it meant.
   */
  unpublishing: Map<string, PendingLayerDelete['file']>;
}

function pushGateOf(provider: SyncProvider): PushGate {
  const status = provider.getStatus();
  return {
    status,
    target: {
      serverCompilesMetadata: status.serverCompilesMetadata === true,
      editLayerSync: status.editLayerSync,
      provider: provider.type
    },
    account: personalLayerAccount(status),
    unpublishing: new Map(
      readPendingDeletes()
        .filter((e) => e.unpublish && isCuratedLayerId(e.layer_id))
        .map((e) => [e.volume_uuid, e.file])
    )
  };
}

/**
 * May this account publish (and so unpublish) the shared `curated` layer of
 * the volume `volumeTitle` in `seriesTitle`? Per volume: bunko 0.8 lets an
 * uploader publish its own uploads in a shared folder.
 */
function canPublishHere(status: ProviderStatus, seriesTitle: string, volumeTitle: string): boolean {
  return status.isReadOnly !== true && canPublishCurated(status, seriesTitle, volumeTitle);
}

/**
 * May this device delete `layerId`'s cloud file? Only where it could push it:
 * a layer that stays local by what it IS (`layerIdStaysLocal` — the shared
 * `curated`, an `edit` the server shares, bunko's own keepsake) is somebody
 * else's file, whatever the account's rights. The one exception is the retry
 * of an Unpublish, by an account that may publish that volume's `curated`.
 */
function canDeleteLayer(
  gate: PushGate,
  layerId: string,
  unpublish?: { volumeUuid: string; seriesTitle: string; volumeTitle: string }
): boolean {
  if (isCuratedLayerId(layerId) && unpublish && gate.unpublishing.has(unpublish.volumeUuid)) {
    return canPublishHere(gate.status, unpublish.seriesTitle, unpublish.volumeTitle);
  }
  return canPushLayer(gate.status, layerId) && !layerIdStaysLocal(layerId, gate.target);
}

/**
 * An Unpublish tombstone's `curated` file is listed under another stamp than
 * the copy it meant to remove: a newer publish (another editor's, or this
 * account's from elsewhere) that the retry must leave alone.
 */
function unpublishedFileMoved(
  gate: PushGate,
  volumeUuid: string,
  layerId: string,
  listed: ListedLayerFile
): boolean {
  if (!isCuratedLayerId(layerId)) return false;
  const meant = gate.unpublishing.get(volumeUuid);
  if (!meant) return false;
  const now = stampOf(listed.file);
  if (meant.size !== undefined && now.size !== undefined && meant.size !== now.size) return true;
  return (
    meant.modified !== undefined && now.modified !== undefined && now.modified > meant.modified
  );
}

/**
 * Corrections that never go up to this server, with edits the cloud has not
 * seen — they are ALWAYS edited since sync, so newest-wins would replace them
 * with no copy kept; they are kept instead:
 *
 * - the account's own, held back from a server that would share them
 *   (`editLayerSync` 'local', a 0.7.x bunko), where the listed
 *   `<Volume>.edit.mokuro` is the library's shared file, another account's;
 * - a server's own OCR edited in place on a bunko (`isCloudModelOutput`): an
 *   edit there forks into `edit`, but one begun before the provider said it
 *   compiles its metadata (signing in, offline, a cloud-direct marker not read
 *   yet) reached the row, and bunko rewrites such a layer in place when its
 *   engine moves on. "On a bunko" = the status says so NOW, or the row was
 *   pulled while it did (`cloud.server_compiled`).
 */
function keepsLocalEdits(row: VolumeOcrLayer | undefined, target: LayerTarget): boolean {
  if (!row || isPassiveSnapshot(row) || !editedSinceSync(row)) return false;
  if (isPersonalLayerId(row.layer_id)) return layerIdStaysLocal(row.layer_id, target);
  // The row's own record counts as much as the status: a stale cloud-direct
  // marker or a failed identity probe reads plain storage again, and the
  // server's rewrite would then replace the corrections with no copy kept.
  const compiled = target.serverCompilesMetadata || pulledFromCompilingServer(row, target);
  return compiled && isCloudModelOutput(row);
}

/** Same key every "which row is this cloud file" question uses. */
function rowKey(volumeTitle: string): string {
  return normalizeVolumeTitleKey(volumeTitle);
}

/**
 * The archive a local row is the volume OF, among a folder's archive stems as
 * listed: spelled exactly like the row's title, else the naturalSort-first of
 * those whose title folds alike — the pick `getManagedCloudFilesForVolume`
 * makes. Two archives that fold alike (`Vol 1.cbz` and `vol 1.cbz`, on
 * case-sensitive storage) are two volumes that `rowsInFolder` folds onto ONE
 * row; the row owns the layers of exactly one of them.
 */
function ownArchiveOfRow(volumeTitle: string, archiveStems: Iterable<string>): string | undefined {
  const key = rowKey(volumeTitle);
  let best: string | undefined;
  for (const stem of archiveStems) {
    if (stem === volumeTitle) return stem;
    if (rowKey(stem) !== key) continue;
    if (best === undefined || naturalSort(stem, best) < 0) best = stem;
  }
  return best;
}

/** A folder's archive stems as listed (`Vol 1` of `Series/Vol 1.cbz`), every spelling. */
function archiveSpellingsOf(files: CloudFileMetadata[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const name = basename(file.path);
    if (isCbzFile(name)) out.push(name.slice(0, -4));
  }
  return out;
}

/**
 * A row's own archive stem in a cached listing (`ownArchiveOfRow` over the
 * folder that folds to the row's series), or undefined when the listing shows
 * no archive for it — an unloaded or stale cache shows nothing for every file.
 */
function ownArchiveInListing(
  listing: Map<string, CloudFileMetadata[]>,
  row: Pick<VolumeMetadata, 'series_title' | 'volume_title'>
): string | undefined {
  const seriesKey = normalizeSeriesKey(row.series_title);
  for (const [folder, files] of listing) {
    if (normalizeSeriesKey(folder) !== seriesKey) continue;
    const own = ownArchiveOfRow(row.volume_title, archiveSpellingsOf(files));
    if (own !== undefined) return own;
  }
  return undefined;
}

/**
 * The local series titles, folded ONCE per listing run (keys-only cursor).
 * `literals` maps a folded series key to every stored spelling of it;
 * `withLocalWork` holds the keys whose series has a volume with a layer row
 * or a pending delete — the only folders that need planning when the listing
 * shows no layer files in them. Folding per folder instead re-read and
 * re-folded every title for every cloud folder, on every listing.
 */
interface LocalSeriesIndex {
  literals: Map<string, string[]>;
  withLocalWork: Set<string>;
}

async function buildLocalSeriesIndex(localWork: Set<string>): Promise<LocalSeriesIndex> {
  const literals = new Map<string, string[]>();
  const withLocalWork = new Set<string>();
  const folded = new Map<string, string>();
  await db.volumes.orderBy('series_title').eachKey((key, cursor) => {
    const title = String(key);
    let seriesKey = folded.get(title);
    if (seriesKey === undefined) {
      seriesKey = normalizeSeriesKey(title);
      folded.set(title, seriesKey);
      const spellings = literals.get(seriesKey);
      if (spellings) spellings.push(title);
      else literals.set(seriesKey, [title]);
    }
    if (localWork.has(String(cursor.primaryKey))) withLocalWork.add(seriesKey);
  });
  return { literals, withLocalWork };
}

async function rowsInFolder(
  folderTitle: string,
  index: LocalSeriesIndex
): Promise<Map<string, VolumeMetadata>> {
  const spellings = index.literals.get(normalizeSeriesKey(folderTitle));
  if (!spellings) return new Map();
  const rows = (await db.volumes
    .where('series_title')
    .anyOf(spellings)
    .toArray()) as VolumeMetadata[];
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

/** What went wrong with a pull that a caller must not mistake for "nothing there". */
interface PullReport {
  /** A file that needed pulling could not be downloaded (offline, a server error). */
  failed: boolean;
}

/** Download + decode one listed layer file; null when unusable. */
async function readLayerFile(
  provider: SyncProvider,
  listed: ListedLayerFile,
  report?: PullReport
): Promise<PulledLayerFile | null> {
  let blob: Blob;
  try {
    blob = await provider.downloadFile(listed.file);
  } catch (error) {
    console.warn(`[layer-sync] could not read '${listed.file.path}':`, error);
    if (report) report.failed = true;
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
  existing: VolumeOcrLayer | undefined,
  report?: PullReport
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
  const pulled = await readLayerFile(provider, listed, report);
  if (!pulled) return false;
  const status = provider.getStatus();
  const stored = await storePulledLayer(row, listed.layerId, pulled, existing, {
    provider: provider.type,
    account: personalLayerAccount(status),
    serverCompiled: status.serverCompilesMetadata === true,
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
  source: {
    provider: string;
    /** The provider's `accountScope`, stamped on a personal layer. */
    account?: string;
    /** The provider said the server compiles its metadata (`cloud.server_compiled`). */
    serverCompiled?: boolean;
    stamp: { size?: number; modified?: number };
    label: string;
  }
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
  // OCR is re-filed as what it is. Never a row made here by hand, never one
  // already attributed to an engine, and never a corrections layer (`curated`,
  // `edit`, `curated-<n>`), whatever stamp its file carries.
  const misfiled =
    existing?.kind === 'edit' &&
    !existing.engine &&
    !!existing.cloud &&
    !!pulled.engine &&
    !isCorrectionsLayerId(layerId);
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
    cloud: {
      provider: source.provider,
      ...accountStamp(layerId, source.account),
      ...(source.serverCompiled ? { server_compiled: true as const } : {}),
      ...source.stamp,
      synced_at: now
    }
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

/**
 * Pushes the server refused (403: an uploader updating a layer file of a
 * volume another account owns), by layer and the edit that was refused.
 * Session-scoped: asking again on every listing would be refused the same way
 * forever; a new edit of the layer, or the next page load, asks again.
 */
const refusedPushes = new Set<string>();

/** `{ account }` for a personal layer (its file is the account's own), else nothing. */
function accountStamp(layerId: string, account: string | undefined): { account?: string } {
  return account && isPersonalLayerId(layerId) ? { account } : {};
}

function refusedPushKey(layer: Pick<VolumeOcrLayer, 'volume_uuid' | 'layer_id' | 'updated_at'>) {
  return `${layer.volume_uuid}\u0000${layer.layer_id}\u0000${layer.updated_at}`;
}

function isPermissionRefusal(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    (error.code === 'PERMISSION_DENIED' || error.webdavErrorType === 'permission')
  );
}

/** Tests: forget the refusals of earlier runs. */
export function resetRefusedLayerPushesForTest(): void {
  refusedPushes.clear();
}

async function pushOne(
  provider: SyncProvider,
  folderTitle: string,
  stem: string,
  row: VolumeMetadata,
  planned: VolumeOcrLayer,
  gzSiblings: CloudFileMetadata[] = [],
  account?: string
): Promise<boolean> {
  try {
    // The plan carries metadata only — it is drawn up for a whole listing, and
    // holding every pushable layer's pages until its turn in the pool would be
    // the library's OCR in memory. The pages are read here, one layer at a time.
    const layer = await getLayerWithPages(db, planned.volume_uuid, planned.layer_id);
    if (!layer) return false; // deleted since the plan
    const { totalChars } = buildPageCharCounts(layer.pages);
    // Only an edit-kind file names its base (the `edited` block).
    const baseSeal = layer.kind === 'edit' ? await editBaseSeal(db, row) : null;
    const meta = buildLayerMokuroMetadata(row, layer, totalChars, { baseSeal });
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
        ...accountStamp(layer.layer_id, account),
        size: uploaded.size ?? blob.size,
        ...(uploaded.modifiedTime ? { modified: isoToEpochSeconds(uploaded.modifiedTime) } : {}),
        synced_at: now
      }
    });
  } catch (error) {
    if (isPermissionRefusal(error)) {
      refusedPushes.add(refusedPushKey(planned));
      console.debug(
        `[layer-sync] the server refused layer '${planned.layer_id}' of '${stem}'; not asked again this session`
      );
      return false;
    }
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
 * lists a layer for every volume of the library. `volumesWithLayers` and
 * the run's `LocalSeriesIndex` (keys-only reads, once per listing, `runSync`)
 * let a folder with no listed layer files skip even its `volumes` query
 * unless one of those volumes, or a pending delete, is in it.
 */
async function planFolder(
  folderTitle: string,
  files: CloudFileMetadata[],
  layerFiles: ListedLayerFile[],
  providerType: ProviderType,
  gate: PushGate,
  pendingDeletes: Map<string, Set<string>>,
  volumesWithLayers: Set<string>,
  index: LocalSeriesIndex
): Promise<Transfer[]> {
  // Nothing listed here, no local layer or tombstone in this series: done.
  if (layerFiles.length === 0 && !index.withLocalWork.has(normalizeSeriesKey(folderTitle))) {
    return [];
  }
  const rows = await rowsInFolder(folderTitle, index);
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
  const archives = archiveSpellingsOf(files);
  const transfers: Transfer[] = [];
  // A listed layer belongs to a row only when its owner archive (as
  // `collectLayerFiles` resolved it) IS the row's own archive. Two archives
  // that fold alike are two volumes on one local row: the other spelling's
  // layers are neither pulled onto this row nor deleted with its tombstones,
  // so a deleted layer cannot come back carrying the other archive's text.
  const ownArchives = new Map<string, string | undefined>();
  const rowByArchive = new Map<string, VolumeMetadata>();
  for (const row of rows.values()) {
    const own = ownArchiveOfRow(row.volume_title, archives);
    ownArchives.set(row.volume_uuid, own);
    if (own !== undefined) rowByArchive.set(own, row);
  }
  const listedByRow = new Map<string, Map<string, ListedLayerFile>>();
  for (const listed of layerFiles) {
    const row = rowByArchive.get(listed.stem);
    if (!row) continue;
    let perRow = listedByRow.get(row.volume_uuid);
    if (!perRow) listedByRow.set(row.volume_uuid, (perRow = new Map()));
    perRow.set(listed.layerId, listed);
  }
  for (const row of rows.values()) {
    const archiveStem = ownArchives.get(row.volume_uuid);
    const local = localByVolume.get(row.volume_uuid) ?? [];
    await refileKnownEngineRows(local);
    const localById = new Map(local.map((l) => [l.layer_id, l]));
    const listed = listedByRow.get(row.volume_uuid) ?? new Map<string, ListedLayerFile>();
    const tombstoned = new Set<string>();
    for (const layerId of pendingDeletes.get(row.volume_uuid) ?? []) {
      // A row under that id again means it was re-created (new layer, import,
      // promote) — and a listing that no longer shows the file has nothing
      // left to pull back. Either way the tombstone is spent. So is an
      // Unpublish whose file moved since: another editor published anew.
      if (
        localById.has(layerId) ||
        !listed.has(layerId) ||
        unpublishedFileMoved(gate, row.volume_uuid, layerId, listed.get(layerId)!)
      ) {
        clearPendingLayerDelete(row.volume_uuid, layerId);
      } else {
        tombstoned.add(layerId);
      }
    }
    for (const [layerId, file] of listed) {
      if (tombstoned.has(layerId)) {
        // Deleted here: never pulled back; removed as soon as the cloud allows
        // (and only a file this device could have pushed: `canDeleteLayer`).
        if (
          canDeleteLayer(gate, layerId, {
            volumeUuid: row.volume_uuid,
            seriesTitle: folderTitle,
            volumeTitle: file.stem
          })
        ) {
          transfers.push({ kind: 'delete', listed: file, volumeUuid: row.volume_uuid });
        }
        continue;
      }
      const existing = localById.get(layerId);
      if (keepsLocalEdits(existing, gate.target)) continue;
      if (layerNeedsPull(existing, file.file, providerType, gate.account)) {
        transfers.push({ kind: 'pull', listed: file, row, existing });
      }
    }
    if (archiveStem === undefined) continue;
    for (const layer of local) {
      // Per layer: a progress-only account still writes its own `edit` overlay.
      if (!canPushLayer(gate.status, layer.layer_id)) continue;
      const listedLayer = listed.get(layer.layer_id);
      const gzSiblings = gzCopiesOf(listedLayer);
      if (
        layerNeedsPush(layer, listedLayer?.file, providerType, gate.target, gate.account) &&
        !refusedPushes.has(refusedPushKey(layer))
      ) {
        transfers.push({ kind: 'push', folderTitle, stem: archiveStem, row, layer, gzSiblings });
      } else if (
        // The retry of a sibling delete that failed (here or on another
        // device): the plain file is listed and is the copy this row is in
        // sync with, so the `.gz` behind it is shadowed for good. A row that
        // never synced with this provider vouches for nothing, and a layer
        // that is somebody else's file is never tidied (`canDeleteLayer`).
        gzSiblings.length > 0 &&
        canDeleteLayer(gate, layer.layer_id) &&
        listedLayer &&
        !listedLayer.gz &&
        layer.cloud?.provider === providerType &&
        !layerNeedsPull(layer, listedLayer.file, providerType, gate.account)
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
  // Listing- and edit-triggered runs come outside the progress sync: the
  // edit-layer gate must follow the server NOW (throttled), or a bunko rolled
  // back under an open tab gets the account's overlay into its SHARED library.
  await refreshGates(provider);
  const gate = pushGateOf(provider);

  await migrateEditedPrimariesToEditLayers();
  await dropPendingDeletesOfMissingVolumes().catch(() => {});
  await dropRejectedFilesOfMissingVolumes().catch(() => {});
  const pendingDeletes = pendingDeletesFor(providerType, gate.account);
  const volumesWithLayers = await listVolumeUuidsWithLayers(db);

  const layerFiles = collectLayerFiles(cloudFilesMap);
  // Nothing listed, nothing local, no tombstone: every folder skips, unread.
  const index: LocalSeriesIndex =
    layerFiles.length === 0 && volumesWithLayers.size === 0 && pendingDeletes.size === 0
      ? { literals: new Map(), withLocalWork: new Set() }
      : await buildLocalSeriesIndex(new Set([...volumesWithLayers, ...pendingDeletes.keys()]));
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
          gate,
          pendingDeletes,
          volumesWithLayers,
          index
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
    } else if (
      await pushOne(provider, t.folderTitle, t.stem, t.row, t.layer, t.gzSiblings, gate.account)
    ) {
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

// ---------------------------------------------------------------- the edit-layer migration

/** The pre-D4 backfill's list of edited volumes whose main-sidecar upload was still due. */
const LEGACY_EDITED_MARKER_KEY = 'sidecar-backfill:edited-volumes';
const EDIT_LAYER_MIGRATION_KEY = 'layer-sync:edit-layer-migration:v1';
let editLayerMigration: Promise<number> | null = null;

/**
 * Once per device: give every EDITED volume (`ocr_edited_at`) whose corrections
 * live only in its primary row — edits made before bunko design 0.8 D4, when
 * an edit re-uploaded the main sidecar — an `edit` layer holding that primary,
 * so the corrections reach the cloud as `<Volume>.edit.mokuro` now that the
 * main sidecar is never re-uploaded after an edit. A volume whose primary
 * equals ANY of its layers has nothing to carry — its `original` snapshot
 * (never edited), or a layer it was promoted from (`promoteLayer` stamps
 * `ocr_edited_at` too and keeps the layer: an engine's OCR, the cloud's
 * `updated-ocr`, the shared `curated` are not this account's corrections);
 * one that already has an `edit` layer keeps it. Additive only (nothing is deleted or
 * changed), and the old backfill's localStorage list is dropped. Resolves the
 * number of layers made; never rejects.
 *
 * On a shared server it publishes nothing of its own: it makes no `curated`
 * row and no upload. Where the made layer goes is the push rule's alone
 * (`layerNeedsPush`): nowhere on a 0.7.x bunko, which would share it
 * (`editLayerSync` 'local' — and its shared `edit` file is never pulled over
 * it, `keepsLocalEdits`); into the account's own overlay on a bunko that keeps
 * one per account; as a plain layer file on plain storage and in cloud-direct
 * folders, which are the user's own.
 */
export function migrateEditedPrimariesToEditLayers(): Promise<number> {
  if (editLayerMigration) return editLayerMigration;
  editLayerMigration = (async () => {
    try {
      if (globalThis.localStorage?.getItem(EDIT_LAYER_MIGRATION_KEY) === 'done') return 0;
    } catch {
      // Storage unavailable: run it (it is idempotent), once this session.
    }
    let made = 0;
    try {
      // Only edits from before the new write path: later ones already have
      // their layer, and a later promotion must stay a local view.
      const epoch = editLayerEpoch();
      const index = db.volumes.where('ocr_edited_at');
      const uuids = (await (
        epoch ? index.between('', epoch, false, false) : index.above('')
      ).primaryKeys()) as string[];
      for (const uuid of uuids) {
        try {
          if (await carryPrimaryIntoEditLayer(uuid)) made++;
        } catch (error) {
          console.debug(`[layer-sync] could not migrate the edits of ${uuid}:`, error);
        }
      }
      try {
        globalThis.localStorage?.removeItem(LEGACY_EDITED_MARKER_KEY);
        globalThis.localStorage?.setItem(EDIT_LAYER_MIGRATION_KEY, 'done');
      } catch {
        // The next session runs it again: idempotent.
      }
      if (made)
        console.log(`[layer-sync] moved the corrections of ${made} volume(s) into an edit layer`);
    } catch (error) {
      console.debug('[layer-sync] edit-layer migration skipped:', error);
      editLayerMigration = null;
    }
    return made;
  })();
  return editLayerMigration;
}

async function carryPrimaryIntoEditLayer(volumeUuid: string): Promise<boolean> {
  return db.transaction('rw', [db.volumes, db.volume_ocr, ...layerTables(db)], async () => {
    const row = await db.volumes.get(volumeUuid);
    if (!row?.ocr_edited_at || !isVolumeInstalled(row)) return false;
    if (await getLayerMeta(db, volumeUuid, EDIT_LAYER_ID)) return false;
    const ocr = await db.volume_ocr.get(volumeUuid);
    if (!ocr?.pages?.length) return false;
    // Equal to a layer = no corrections of the account's own: the untouched
    // `original`, or a promoted layer — an engine's or the OCR upgrade's
    // (pushed as `edit` it would publish model output as hand corrections), the
    // shared `curated` (the account's own copy of everyone's work). A
    // pre-epoch `promoteLayer` stamps `ocr_edited_at` like a hand edit, so the
    // stamp alone cannot tell. One layer's pages at a time, this volume only.
    const primary = JSON.stringify(ocr.pages);
    for (const layerId of await listLayerIds(db, volumeUuid)) {
      const pages = await getLayerPages(db, volumeUuid, layerId);
      if (pages && pages.length === ocr.pages.length && JSON.stringify(pages) === primary) {
        return false;
      }
    }
    // Stamped with the edit's own time, so it ranks as the edit it is.
    const at = row.ocr_edited_at;
    await putLayerWithPages(db, {
      volume_uuid: volumeUuid,
      layer_id: EDIT_LAYER_ID,
      name: layerNameForId(EDIT_LAYER_ID),
      kind: 'edit',
      created_at: at,
      updated_at: at,
      pages: ocr.pages
    });
    return true;
  });
}

/** Tests: run the migration again. */
export function resetEditLayerMigrationForTest(): void {
  editLayerMigration = null;
}

/** How long after the last layer edit its push waits (an editing session autosaves often). */
export const LAYER_PUSH_DEBOUNCE_MS = 15_000;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A layer was just edited here (the editor's `edit` layer, or any layer edited
 * in place): run the layer sync against the CACHED listing once the edits
 * settle, so the change goes up without waiting for the next whole-account
 * listing. Never fetches a listing; does nothing without a connected provider
 * whose listing cache is loaded (the next listing pushes it then).
 */
export function scheduleLayerPush(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    try {
      const provider = providerManager.getActiveProvider();
      if (!provider) return;
      if (!cacheManager.getCache(provider.type)?.isLoaded?.()) return;
      void syncLayersFromListing(listingFromCache(provider.type), provider.type);
    } catch (error) {
      console.debug('[layer-sync] scheduled push skipped:', error);
    }
  }, LAYER_PUSH_DEBOUNCE_MS);
}

/** Tests: drop a scheduled push. */
export function cancelScheduledLayerPushForTest(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
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
  providerType: ProviderType,
  /** Only these layer ids (default: every listed layer of the volume). */
  only?: string[],
  /** Set when a file that needed pulling could not be downloaded. */
  report?: PullReport
): Promise<number> {
  try {
    const row = await db.volumes.get(volumeUuid);
    if (!row || row.isPlaceholder) return 0;
    const provider = providerManager.getActiveProvider();
    if (!provider || provider.type !== providerType) return 0;
    const listing = listingFromCache(providerType);
    const seriesKey = normalizeSeriesKey(row.series_title);
    const own = ownArchiveInListing(listing, row);
    const mine = collectLayerFiles(listing).filter(
      (l) =>
        normalizeSeriesKey(l.folderTitle) === seriesKey &&
        l.stem === own &&
        (!only || only.includes(l.layerId))
    );
    // Read once for the whole volume, not per layer: it parses the pending
    // deletes and asks the provider for its status.
    const gate = pushGateOf(provider);
    const tombstoned = pendingDeletesFor(providerType, gate.account).get(volumeUuid);
    let pulled = 0;
    await runPool(mine, MAX_CONCURRENT_LAYER_TRANSFERS, async (listed) => {
      const existing = await getLayerMeta(db, volumeUuid, listed.layerId);
      // Deleted here and not re-created: a fresh download must not bring it back.
      if (!existing && tombstoned?.has(listed.layerId)) return;
      if (keepsLocalEdits(existing, gate.target)) return;
      if (!layerNeedsPull(existing, listed.file, providerType, gate.account)) return;
      if (await pullOne(provider, listed, row, existing, report)) pulled++;
    });
    return pulled;
  } catch (error) {
    console.warn('[layer-sync] pull for volume failed:', error);
    if (report) report.failed = true;
    return 0;
  }
}

/** `pullOwnEditLayerBeforeEdit`'s answer. */
export type OwnEditLayerPull = 'pulled' | 'none' | 'failed';

/**
 * Before anything mints the account's `edit` layer — a fork
 * (`forkIntoEditLayer`) from a shared layer, or the first save of an edit of
 * the primary (`persistPageEdit` makes `edit` from the primary): an overlay of
 * the account's own already in the cached listing (pushed from another device,
 * not pulled here yet) is pulled first, so the edit goes into THAT. A fresh
 * copy would be newer than it and replace it on the next sync, taking the
 * other device's corrections with it. Only where the account's `edit` goes up
 * at all — elsewhere the listed file is not its own.
 *
 * `'pulled'`: the row is here now. `'none'`: nothing to pull (no provider, a
 * local `edit` row already, none listed, a file that is no layer of this
 * volume). `'failed'`: a listed overlay could not be downloaded — the caller
 * must NOT mint a fresh `edit`, or the next push replaces that file. Never
 * rejects.
 */
export async function pullOwnEditLayerBeforeEdit(volumeUuid: string): Promise<OwnEditLayerPull> {
  try {
    const provider = providerManager.getActiveProvider();
    if (!provider) return 'none';
    if (layerIdStaysLocal(EDIT_LAYER_ID, pushGateOf(provider).target)) return 'none';
    if (await getLayerMeta(db, volumeUuid, EDIT_LAYER_ID)) return 'none';
    const report: PullReport = { failed: false };
    const pulled = await pullLayersForVolume(volumeUuid, provider.type, [EDIT_LAYER_ID], report);
    if (pulled > 0) return 'pulled';
    return report.failed ? 'failed' : 'none';
  } catch (error) {
    console.warn('[layer-sync] could not pull the edit layer before an edit:', error);
    return 'failed';
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
 * a copy may survive (offline, read-only, synced with another provider or
 * account, the request failed, no listing to consult) — the caller must leave
 * a tombstone. `'kept-shared'`: the listed file is somebody else's by what the
 * layer is (`layerIdStaysLocal` — the shared `curated`, an `edit` the server
 * shares, a case merge's `curated-<n>`) and is never deleted from here; the tombstone
 * only hides it on this device.
 */
export type CloudLayerDeleteOutcome = 'gone' | 'unconfirmed' | 'kept-shared';

/** One copy's delete: gone, refused by the server (403), or failed otherwise. */
type CopyDeleteOutcome = 'gone' | 'refused' | 'failed';

async function deleteOneCopy(
  provider: SyncProvider,
  file: CloudFileMetadata
): Promise<CopyDeleteOutcome> {
  try {
    await provider.deleteFile(file);
    cacheManager.getCache(provider.type)?.removeById?.(file.fileId);
    return 'gone';
  } catch (error) {
    console.warn(`[layer-sync] could not delete '${file.path}':`, error);
    return isPermissionRefusal(error) ? 'refused' : 'failed';
  }
}

/**
 * Delete EVERY listed copy of a layer (`.mokuro` and `.mokuro.gz`) — the one
 * order every delete of a listed layer takes (a layer delete, a tombstone's
 * retry, an Unpublish). The `.gz` copies go first and the plain file — the one
 * every reader takes while it is listed — last, and the first copy that
 * cannot be deleted stops it, whatever the reason (`'refused'` for a 403,
 * else `'failed'`): the plain file is then still there, so what anyone reads
 * did not change. Going on, a `.gz` that stayed would be read in the plain
 * file's place by everyone. `'gone'` only when every copy went: anything
 * else leaves a copy for the next listing to read the layer back from, so
 * the caller keeps its tombstone and the retry finishes the job.
 */
async function deleteListedLayerCopies(
  provider: SyncProvider,
  listed: ListedLayerFile
): Promise<CopyDeleteOutcome> {
  const copies = [...listed.copies].sort((a, b) => Number(b.gz) - Number(a.gz));
  for (const copy of copies) {
    const one = await deleteOneCopy(provider, copy.file);
    if (one !== 'gone') return one;
  }
  return 'gone';
}

/** `deleteListedLayerCopies` went all the way: no copy is left to read the layer back. */
async function deleteListedLayerFile(
  provider: SyncProvider,
  listed: ListedLayerFile
): Promise<boolean> {
  return (await deleteListedLayerCopies(provider, listed)) === 'gone';
}

/**
 * Where a listing keeps a volume: its folder and its OWN archive's stem
 * (`ownArchiveOfRow`, as `planFolder` picks it), as the listing spells them.
 */
function locateVolumeInListing(
  listing: Map<string, CloudFileMetadata[]>,
  row: Pick<VolumeMetadata, 'series_title' | 'volume_title'>
): { folderTitle: string; stem: string } | null {
  const seriesKey = normalizeSeriesKey(row.series_title);
  for (const [folder, files] of listing) {
    if (normalizeSeriesKey(folder) !== seriesKey) continue;
    const stem = ownArchiveOfRow(row.volume_title, archiveSpellingsOf(files));
    if (stem !== undefined) return { folderTitle: folder, stem };
  }
  return null;
}

/**
 * The listed file(s) of one layer of a volume, if the listing shows any — of
 * the row's OWN archive: a same-id layer of an archive that merely folds alike
 * is another volume's file.
 */
function listedLayerOf(
  listing: Map<string, CloudFileMetadata[]>,
  row: Pick<VolumeMetadata, 'series_title' | 'volume_title'>,
  layerId: string
): ListedLayerFile | undefined {
  const seriesKey = normalizeSeriesKey(row.series_title);
  const own = ownArchiveInListing(listing, row);
  if (own === undefined) return undefined;
  return collectLayerFiles(listing).find(
    (l) =>
      normalizeSeriesKey(l.folderTitle) === seriesKey && l.stem === own && l.layerId === layerId
  );
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
    // A rolled-back bunko shares the `edit` path again: ask first (throttled).
    const status = await freshGateStatus(provider);
    // Another account's personal layer: the listed file at that path is the
    // ACTIVE account's own overlay, not the copy this row was synced with.
    if (syncedForOtherAccount(layer, personalLayerAccount(status))) return 'unconfirmed';
    const listing = listingFromCache(provider.type);
    const listed = listedLayerOf(listing, row, layer.layer_id);
    if (!listed) {
      // "Not listed" is only proof from a cache that covers this volume — an
      // unloaded or stale cache shows nothing for every file.
      return locateVolumeInListing(listing, row) ? 'gone' : 'unconfirmed';
    }
    const gate = pushGateOf(provider);
    if (!canDeleteLayer(gate, layer.layer_id)) {
      // Somebody else's file by what the layer IS: no listing will ever remove it.
      return layerIdStaysLocal(layer.layer_id, gate.target) ? 'kept-shared' : 'unconfirmed';
    }
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
  uploaded: LayerUploadSnapshot[],
  /** The provider's `accountScope`, recorded on a personal layer (`VolumeOcrLayer.cloud`). */
  account?: string
): Promise<void> {
  try {
    const now = new Date().toISOString();
    for (const snapshot of uploaded) {
      // Read-compare-write in one transaction: an edit cannot slip in between.
      await patchLayerMeta(db, volumeUuid, snapshot.layerId, (row) => ({
        cloud: {
          provider: providerType,
          ...accountStamp(snapshot.layerId, account),
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
  // A personal layer's tombstone belongs to the account whose file it is.
  let account: { account?: string } = {};
  try {
    const [row, layer] = await Promise.all([
      db.volumes.get(volumeUuid),
      getLayerMeta(db, volumeUuid, layerId)
    ]);
    if (!row || !layer) return 'gone';
    const active = providerManager.getActiveProvider();
    provider = layer.cloud?.provider ?? active?.type;
    const scope = active ? personalLayerAccount(active.getStatus()) : undefined;
    account = accountStamp(layerId, layer.cloud?.account ?? scope);
    const outcome = await deleteLayerFileInCloud(row, layer);
    if (outcome === 'gone') clearPendingLayerDelete(volumeUuid, layerId);
    else
      notePendingLayerDelete({ volume_uuid: volumeUuid, layer_id: layerId, provider, ...account });
    return outcome;
  } catch (error) {
    console.warn('[layer-sync] could not delete the cloud layer file:', error);
    notePendingLayerDelete({ volume_uuid: volumeUuid, layer_id: layerId, provider, ...account });
    return 'unconfirmed';
  }
}

// ---------------------------------------------------------------- the shared curated layer

/** What a Publish came to: up, refused by the server or the account's rights, or not done. */
export type CuratedPublishOutcome = 'published' | 'refused' | 'failed';

/** The listed `<Volume>.curated.mokuro[.gz]` of a volume on the active provider, if any. */
export async function listedCuratedLayerFile(
  volumeUuid: string
): Promise<CloudFileMetadata | null> {
  try {
    const provider = providerManager.getActiveProvider();
    const row = await db.volumes.get(volumeUuid);
    if (!provider || !row) return null;
    return listedLayerOf(listingFromCache(provider.type), row, CURATED_LAYER_ID)?.file ?? null;
  } catch {
    return null;
  }
}

/**
 * Publish: the account's `edit` layer becomes the library's shared corrections,
 * `<folder>/<stem>.curated.mokuro` beside the archive (the listing's spelling).
 * The ONLY path that writes `curated` — sync never pushes it
 * (`layerIdStaysLocal`). The file is the edit layer's own serialization, with
 * its `edited` block (`buildLayerMokuroMetadata`) and the same `base_seal` an
 * edit push names (`editBaseSeal`). The local `curated` row then
 * takes the same pages and the upload's stamp, so the next listing neither
 * pulls it back nor sees anything to push.
 *
 * 'refused': the account may not publish this volume (`canPublishCurated`,
 * per volume; the server stays the judge, so its 403 is final).
 * 'failed': nothing to publish, no listing that places the volume, or the
 * upload failed. Nothing is written locally unless it went up. Never rejects.
 */
export async function publishCuratedLayer(volumeUuid: string): Promise<CuratedPublishOutcome> {
  try {
    const provider = providerManager.getActiveProvider();
    if (!provider) return 'failed';
    const [row, edit] = await Promise.all([
      db.volumes.get(volumeUuid),
      getLayerWithPages(db, volumeUuid, EDIT_LAYER_ID)
    ]);
    if (!row || !edit) return 'failed';
    if (!canPublishHere(provider.getStatus(), row.series_title, row.volume_title)) return 'refused';
    const listing = listingFromCache(provider.type);
    const place = locateVolumeInListing(listing, row);
    if (!place) return 'failed';
    const { totalChars } = buildPageCharCounts(edit.pages);
    const baseSeal = await editBaseSeal(db, row);
    const meta = buildLayerMokuroMetadata(row, edit, totalChars, { baseSeal });
    const blob = new Blob([JSON.stringify(meta)], { type: 'application/json' });
    const path = `${place.folderTitle}/${layerSidecarName(place.stem, CURATED_LAYER_ID)}`;
    const uploaded = await provider.uploadFile(path, blob);
    cacheManager
      .getCache(provider.type)
      ?.add?.(path, uploadCacheEntry(provider.type, path, blob.size, uploaded));
    const now = new Date().toISOString();
    const existing = await getLayerMeta(db, volumeUuid, CURATED_LAYER_ID);
    await putLayerWithPages(db, {
      volume_uuid: volumeUuid,
      layer_id: CURATED_LAYER_ID,
      name: existing?.name ?? layerNameForId(CURATED_LAYER_ID),
      kind: 'edit',
      created_at: existing?.created_at ?? now,
      updated_at: now,
      cloud: {
        provider: provider.type,
        size: uploaded.size ?? blob.size,
        ...(uploaded.modifiedTime ? { modified: isoToEpochSeconds(uploaded.modifiedTime) } : {}),
        synced_at: now
      },
      pages: structuredClone(edit.pages)
    });
    clearPendingLayerDelete(volumeUuid, CURATED_LAYER_ID);
    // An engine's `.gz` of the layer would sit shadowed behind the plain file.
    await removeGzSiblings(provider, gzCopiesOf(listedLayerOf(listing, row, CURATED_LAYER_ID)));
    return 'published';
  } catch (error) {
    if (isPermissionRefusal(error)) return 'refused';
    console.warn('[layer-sync] could not publish the shared corrections:', error);
    return 'failed';
  }
}

/**
 * What an Unpublish came to: `CloudLayerDeleteOutcome`, refused (nothing
 * changed), or failed (nothing changed: no provider to remove it from).
 */
export type CuratedUnpublishOutcome =
  | Exclude<CloudLayerDeleteOutcome, 'kept-shared'>
  | 'refused'
  | 'failed';

/**
 * Unpublish: remove the library's shared corrections for everyone — every
 * listed copy (`.mokuro` and `.mokuro.gz`, `deleteListedLayerCopies`: `.gz`
 * first, the plain file last, stopping at the first copy that fails), then the local
 * row. A refusal leaves the plain file there, so nothing anyone reads changed
 * — the row stays and no tombstone is left (`'refused'`), since a retry would
 * be refused the same way. Any other failure still removes the row and
 * leaves an Unpublish tombstone, which hides the file and is retried by
 * later listings (`canDeleteLayer`). The tombstone names the provider the
 * `curated` row was synced with, else the active one; with neither there is
 * nothing to name, and nothing is changed (`'failed'`). Never rejects.
 */
export async function unpublishCuratedLayer(volumeUuid: string): Promise<CuratedUnpublishOutcome> {
  const provider = providerManager.getActiveProvider();
  // The copy this Unpublish means: the listed file, else the one the row was
  // synced with. A retry must not take a newer publish down with it.
  let file: PendingLayerDelete['file'];
  // The provider holding that copy. An Unpublish tombstone without one would
  // apply to every provider's listing (`pendingDeletesFor`).
  let holder: string | undefined = provider?.type;
  const tombstone = (): CuratedUnpublishOutcome => {
    notePendingLayerDelete({
      volume_uuid: volumeUuid,
      layer_id: CURATED_LAYER_ID,
      provider: holder,
      unpublish: true,
      ...(file ? { file } : {})
    });
    return 'unconfirmed';
  };
  try {
    const [row, curated] = await Promise.all([
      db.volumes.get(volumeUuid),
      getLayerMeta(db, volumeUuid, CURATED_LAYER_ID)
    ]);
    if (!row) return 'gone';
    if (curated?.cloud) {
      file = { size: curated.cloud.size, modified: curated.cloud.modified };
      holder = curated.cloud.provider;
    }
    if (!holder) return 'failed';
    if (provider && !canPublishHere(provider.getStatus(), row.series_title, row.volume_title)) {
      return 'refused';
    }
    let outcome: CuratedUnpublishOutcome;
    if (!provider || provider.type !== holder) {
      outcome = tombstone();
    } else {
      const listing = listingFromCache(provider.type);
      const listed = listedLayerOf(listing, row, CURATED_LAYER_ID);
      if (!listed) {
        outcome = locateVolumeInListing(listing, row) ? 'gone' : tombstone();
      } else {
        file = stampOf(listed.file);
        const deleted = await deleteListedLayerCopies(provider, listed);
        if (deleted === 'refused') return 'refused';
        outcome = deleted === 'gone' ? 'gone' : tombstone();
      }
    }
    if (outcome === 'gone') clearPendingLayerDelete(volumeUuid, CURATED_LAYER_ID);
    await deleteLayerRows(db, volumeUuid, CURATED_LAYER_ID);
    return outcome;
  } catch (error) {
    console.warn('[layer-sync] could not unpublish the shared corrections:', error);
    return holder ? tombstone() : 'failed';
  }
}
