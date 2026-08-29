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

async function readCloudContext(rows: VolumeMetadata[]): Promise<CloudContext> {
  const [{ unifiedCloudManager }, { providerManager }, { get }] = await Promise.all([
    import('$lib/util/sync/unified-cloud-manager'),
    import('$lib/util/sync/provider-manager'),
    import('svelte/store')
  ]);

  const status = get(providerManager.status);
  const { canDeleteSeriesOnServer } = await import('$lib/util/sync/metadata-permissions');
  return {
    providerDisplayName: unifiedCloudManager.getActiveProvider()?.name || 'cloud',
    hasAnyProvider: status.hasAnyAuthenticated,
    // Same read-only gate as the series page: a WebDAV account that may not write must
    // not be offered a delete it cannot perform.
    isReadOnlyMode:
      status.currentProviderType === 'webdav' && status.providers['webdav']?.isReadOnly === true,
    hasCloudBackups: rows.some((vol) =>
      unifiedCloudManager.existsInCloud(vol.series_title, vol.volume_title)
    ),
    canDeleteFromServer: rows.length > 0 && canDeleteSeriesOnServer(rows[0].series_title).allowed
  };
}

/**
 * Delete a whole series folder from the connected provider, reporting what happened.
 * Shared by the removal dialog's "also delete from …" box and the series page's own
 * "Delete from …" menu item.
 */
export async function deleteSeriesFromCloudByTitle(seriesTitle: string): Promise<void> {
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

  // O(1) lookup in the cached listing: nothing backed up means nothing to delete.
  if (unifiedCloudManager.getCloudVolumesBySeries(seriesTitle).length === 0) {
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
      await deleteSeriesFromCloudByTitle(rows[0].series_title);
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
