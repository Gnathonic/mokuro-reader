/**
 * What a volume row's keys may do right now (#55, spec 17.10–17.11): the
 * tests the row's own buttons and menu items apply, as functions, so a key
 * bound to "Download volume" or "Back up volume" applies the same ones and
 * says why when it cannot run.
 *
 * The row's menu has ONE item whose meaning follows the volume's state:
 * "Backup to cloud", "Retry upload" or — once the volume is backed up —
 * "Delete from cloud". The Backup key is only ever the first two. On a
 * backed-up volume it says so and stops: deleting the cloud copy stays on its
 * own action (`library.volume-delete-cloud`), which asks first.
 */

export interface VolumeRowState {
  /** The pages are on this device (`!needsDownload`). */
  installed: boolean;
  /** A cloud provider is connected. */
  hasProvider: boolean;
  /** The connection cannot write (read-only WebDAV). */
  readOnly: boolean;
  /** The cloud listing is still loading: backed-up or not is unknown. */
  cloudLoading: boolean;
  /** The volume is in the cloud listing. */
  backedUp: boolean;
  /** The connected cloud has a file to download this volume from. */
  hasCloudFile: boolean;
  /** A download of this volume is queued or running. */
  downloading: boolean;
}

export type RowCommand = { run: true } | { run: false; reason: string };

const run: RowCommand = { run: true };
const no = (reason: string): RowCommand => ({ run: false, reason });

/** Back up, or retry a failed upload. Never anything else. */
export function volumeBackupCommand(s: VolumeRowState): RowCommand {
  if (!s.installed) return no('Not on this device: there is nothing to back up');
  if (!s.hasProvider) return no('Connect cloud storage to back up');
  if (s.readOnly) return no('This cloud connection is read-only');
  if (s.cloudLoading) return no('Cloud status is still loading');
  if (s.backedUp) return no('Already backed up');
  return run;
}

/** The Download button: only a volume whose pages are not here has one. */
export function volumeDownloadCommand(s: VolumeRowState): RowCommand {
  if (s.installed) return no('Already on this device');
  if (s.downloading) return no('Already downloading');
  if (!s.hasCloudFile) return no('Not in the connected cloud storage');
  return run;
}

/** View text and Extract read the pages: an installed volume only. */
export function volumePagesCommand(s: Pick<VolumeRowState, 'installed'>): RowCommand {
  return s.installed ? run : no('Not on this device: download it first');
}
