/**
 * The series "Remove manga" flow, verbatim — the dialog the series page has always
 * shown, lifted out of `SeriesView.svelte` so the catalog's hover + Delete shortcut can
 * raise exactly the same one instead of growing a second, subtly different prompt.
 *
 * Everything the dialog needs about the cloud is read here (backups, provider name,
 * read-only state), so a caller only has to hand over the series' volumes.
 *
 * The heavy halves — the import pipeline, the settings store, the sync stack — are
 * imported lazily on purpose: this module is pulled in by every catalog card, and none of
 * that graph should load until someone actually presses Delete.
 */
import { promptConfirmation } from '$lib/util/modals';
import { showSnackbar } from '$lib/util/snackbar';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { isMetadataOnly } from './volume-state';
import type { VolumeMetadata } from '$lib/types';

/**
 * One prompt at a time. The cloud context is gathered across an `await`, so two Delete
 * presses a frame apart would both get past `anyModalOpen()` (no dialog is up yet) and the
 * second `promptConfirmation` would swap the first dialog out from under the user.
 */
let promptPending = false;

export interface SeriesRemovalOptions {
  /** Run once the rows are gone — the series page uses it to leave the emptied page. */
  onRemoved?: () => void;
}

interface CloudContext {
  providerDisplayName: string;
  hasAnyProvider: boolean;
  isReadOnlyMode: boolean;
  hasCloudBackups: boolean;
  /** Server-side delete permission for THIS series (mirrors the server's rules). */
  canDeleteFromServer: boolean;
}

/** The two titles a cloud lookup needs; real rows and placeholders both carry them. */
type TitledVolume = Pick<VolumeMetadata, 'series_title' | 'volume_title'>;

/** The subset of the cloud manager the folder question reads. */
interface FolderLookup {
  resolveCloudFolderTitle(seriesTitle: string): string;
  existsInCloud(seriesTitle: string, volumeTitle: string): boolean;
  getCloudVolumesBySeries(seriesTitle: string): unknown[];
}

/**
 * Is `folder` — what `resolveCloudFolderTitle` answered for `seriesTitle` — this
 * series' own? Spelled exactly like it, yes. A folder that merely FOLDS onto the title
 * (the one a backup of this series uploads into when no exact folder exists) only when
 * the catalog would group it with this series too, by its own key
 * (`normalizeSeriesKey`). Two titles differing only in unicode form fold alike yet are
 * separate catalog series: the other series' backup must never be offered for, or
 * deleted by, this one — the exact gate used to answer "No volumes found" there.
 */
function folderBelongsToSeries(folder: string, seriesTitle: string): boolean {
  return folder === seriesTitle || normalizeSeriesKey(folder) === normalizeSeriesKey(seriesTitle);
}

/**
 * The cloud folder a delete of THIS series' backups may remove, or null when there is
 * none. An exact folder with anything in it; a folder that only folds onto the title
 * when it is the series' own (`folderBelongsToSeries`) AND lists at least one of the
 * series' own volumes — the corroboration that it holds this series' backups and not a
 * namesake's.
 */
export function cloudFolderOfSeries(
  manager: FolderLookup,
  seriesTitle: string,
  volumes: TitledVolume[]
): string | null {
  const folder = manager.resolveCloudFolderTitle(seriesTitle);
  if (!folderBelongsToSeries(folder, seriesTitle)) return null;
  const holdsBackups =
    folder === seriesTitle
      ? manager.getCloudVolumesBySeries(folder).length > 0
      : volumes.some((vol) => manager.existsInCloud(vol.series_title, vol.volume_title));
  return holdsBackups ? folder : null;
}

async function readCloudContext(rows: VolumeMetadata[]): Promise<CloudContext> {
  const [{ unifiedCloudManager }, { providerManager }, { get }] = await Promise.all([
    import('$lib/util/sync/unified-cloud-manager'),
    import('$lib/util/sync/provider-manager'),
    import('svelte/store')
  ]);

  const status = get(providerManager.status);
  const { canDeleteSeriesOnServer } = await import('$lib/util/sync/metadata-permissions');
  // Backed up = one of these volumes is listed, in a folder that is this series' own:
  // the delete the box offers (`cloudFolderOfSeries`) resolves the folder the same way.
  const hasCloudBackups =
    rows.length > 0 &&
    folderBelongsToSeries(
      unifiedCloudManager.resolveCloudFolderTitle(rows[0].series_title),
      rows[0].series_title
    ) &&
    rows.some((vol) => unifiedCloudManager.existsInCloud(vol.series_title, vol.volume_title));
  return {
    providerDisplayName: unifiedCloudManager.getActiveProvider()?.name || 'cloud',
    hasAnyProvider: status.hasAnyAuthenticated,
    // Same read-only gate as the series page: a WebDAV account that may not write must
    // not be offered a delete it cannot perform.
    isReadOnlyMode:
      status.currentProviderType === 'webdav' && status.providers['webdav']?.isReadOnly === true,
    hasCloudBackups,
    canDeleteFromServer: rows.length > 0 && canDeleteSeriesOnServer(rows[0].series_title).allowed
  };
}

/**
 * Delete a whole series folder from the connected provider, reporting what happened.
 * Shared by the removal dialog's "also delete from …" box and the series page's own
 * "Delete from …" menu item. `volumes` are the series' volumes as the caller has them
 * (rows or placeholders): a folder that only folds onto the title is deleted only when
 * it lists one of them (`cloudFolderOfSeries`).
 */
export async function deleteSeriesFromCloudByTitle(
  seriesTitle: string,
  volumes: TitledVolume[]
): Promise<void> {
  if (!seriesTitle) return;

  // Server rules, checked up front so every entry point (dialog checkbox, series
  // page menu) gets the same block instead of a pile of per-file 403s.
  const { canDeleteSeriesOnServer } = await import('$lib/util/sync/metadata-permissions');
  const permitted = canDeleteSeriesOnServer(seriesTitle);
  if (!permitted.allowed) {
    showSnackbar(permitted.reason ?? "This account can't delete this series on this server");
    return;
  }

  const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
  const providerDisplayName = unifiedCloudManager.getActiveProvider()?.name || 'cloud';

  // Nothing backed up means nothing to delete. The folder as the CLOUD spells it,
  // resolved the way the dialog's "backed up?" check (which offered this delete) and
  // `deleteSeriesFolder` (which performs it) resolve it: a server that merged
  // `one piece/` into `One Piece/` must not answer "No volumes found" — but a folder
  // that is another catalog series' (`cloudFolderOfSeries`) must.
  if (cloudFolderOfSeries(unifiedCloudManager, seriesTitle, volumes) === null) {
    showSnackbar(`No volumes found in ${providerDisplayName}`);
    return;
  }

  try {
    // deleteSeriesFolder updates the manager's cache itself — no refetch needed.
    const result = await unifiedCloudManager.deleteSeriesFolder(seriesTitle);
    if (result.failed === 0) {
      showSnackbar(`Deleted ${result.succeeded} volume(s) from ${providerDisplayName}`);
    } else {
      showSnackbar(`Deleted ${result.succeeded} volume(s), ${result.failed} failed`);
    }
  } catch (error) {
    console.error(`Failed to delete series from ${providerDisplayName}:`, error);
    showSnackbar(`Failed to delete from ${providerDisplayName}`);
    // Refresh the cache so the view stops showing a state the delete never reached.
    await unifiedCloudManager.fetchAllCloudVolumes();
  }
}

/**
 * Raise the series removal confirmation for `volumes`.
 *
 * Placeholders are skipped: they are cloud listings, not rows, so there is nothing on
 * this device to remove. Returns whether a dialog was actually opened.
 */
export async function promptSeriesRemoval(
  volumes: VolumeMetadata[],
  options: SeriesRemovalOptions = {}
): Promise<boolean> {
  const rows = volumes.filter((vol) => !vol.isPlaceholder);
  if (rows.length === 0) return false;
  if (promptPending) return false;
  promptPending = true;

  try {
    return await raisePrompt(rows, options);
  } finally {
    // Released as soon as the dialog is up — from there `anyModalOpen()` is what keeps a
    // second one from opening, and a cancelled dialog must leave the next press free.
    promptPending = false;
  }
}

async function raisePrompt(
  rows: VolumeMetadata[],
  options: SeriesRemovalOptions
): Promise<boolean> {
  const cloud = await readCloudContext(rows);

  // Every volume's pages are already gone: "remove from device" would do nothing, so the
  // dialog becomes the forget action, with no checkbox to leave unticked.
  const allAlreadyRemoved = rows.every(isMetadataOnly);

  async function confirmDelete(forget = false, deleteCloud = false) {
    const deleteStats = forget || allAlreadyRemoved;
    const seriesUuid = rows[0].series_uuid;
    if (!seriesUuid) return;

    const [{ removeVolumeFiles, deleteVolumeCompletely }, { deleteVolume: deleteVolumeStats }] =
      await Promise.all([import('$lib/import'), import('$lib/settings')]);

    await Promise.all(
      rows.map(async (vol) => {
        // Default: strip the pages, keep the rows — they carry the read history and the
        // covers (see removeVolumeFiles).
        if (deleteStats) {
          await deleteVolumeCompletely(vol.volume_uuid);
          deleteVolumeStats(vol.volume_uuid);
        } else {
          await removeVolumeFiles(vol.volume_uuid);
        }
      })
    );

    if (deleteCloud && cloud.hasAnyProvider) {
      await deleteSeriesFromCloudByTitle(rows[0].series_title, rows);
    }

    options.onRemoved?.();
  }

  promptConfirmation(
    allAlreadyRemoved
      ? 'Forget this manga? Its stats, progress and covers will be deleted.'
      : 'Remove this manga from this device? Stats, progress and covers are kept.',
    confirmDelete,
    undefined,
    // New storage key on purpose — see VolumeItem: the box's meaning changed.
    allAlreadyRemoved
      ? undefined
      : {
          label: 'Also forget stats, progress and covers?',
          storageKey: 'forgetVolumePreference',
          defaultValue: false
        },
    cloud.hasCloudBackups && !cloud.isReadOnlyMode && cloud.canDeleteFromServer
      ? {
          label: `Also delete from ${cloud.providerDisplayName}?`,
          storageKey: 'deleteCloudPreference',
          defaultValue: false
        }
      : undefined
  );

  return true;
}
