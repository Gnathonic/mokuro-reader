/**
 * What the connected ACCOUNT may do on its server, beyond read-only or not.
 *
 * mokuro-bunko's identity endpoint reports per-role permissions
 * (`providers/webdav/identity.ts`): a `registered` account may write its own
 * progress but not add library files; only a modify/delete role may MOVE
 * (bunko gates MOVE/COPY on MODIFY_DELETE, ownership or not). `isReadOnly`
 * stays false for such an account — progress must keep syncing — so every
 * library write asks here first. A provider that reports nothing (generic
 * WebDAV, every other provider) reads as unrestricted: absent = allowed.
 *
 * Pure, dependency-free: takes a `ProviderStatus` (or nothing).
 */
import {
  ProviderError,
  type AddFilesPermissions,
  type CuratedVolume,
  type ProviderStatus
} from './provider-interface';
import { normalizeVolumeTitleKey } from '$lib/metadata/series-key';

type Capabilities = Pick<ProviderStatus, 'canAddFiles' | 'canModifyDelete'>;

export const CANNOT_ADD_FILES_MESSAGE = "This account can't add files on this server";
export const CANNOT_RENAME_MESSAGE = "This account can't rename on this server";
export const CANNOT_PUBLISH_CURATED_MESSAGE =
  "This account can't publish shared corrections for this volume";

/** May this account upload archives, sidecars and layer files, and create folders? */
export function accountCanAddFiles(status: Capabilities | null | undefined): boolean {
  return status?.canAddFiles !== false;
}

export const CANNOT_ADD_TO_SERIES_MESSAGE = 'This series belongs to another account on this server';

/** Folded `closedSeries`, per permissions OBJECT: a fresh identity folds once, never per call. */
const closedKeysByPermissions = new WeakMap<AddFilesPermissions, Set<string>>();

function closedKeys(permissions: AddFilesPermissions): Set<string> {
  let keys = closedKeysByPermissions.get(permissions);
  if (!keys) {
    keys = new Set((permissions.closedSeries ?? []).map(normalizeVolumeTitleKey));
    closedKeysByPermissions.set(permissions, keys);
  }
  return keys;
}

/**
 * May this account add files to the series FOLDER `seriesTitle`? bunko 0.8
 * records a series' owner (its first uploader), and an uploader may add
 * nothing to a series another account owns (`addFilesPermissions.closedSeries`,
 * folded like every series-folder match). Absent permissions close nothing.
 */
export function accountCanAddToSeries(
  status: Pick<ProviderStatus, 'canAddFiles' | 'addFilesPermissions'> | null | undefined,
  seriesTitle: string
): boolean {
  if (!accountCanAddFiles(status)) return false;
  const permissions = status?.addFilesPermissions;
  switch (permissions?.scope) {
    case 'none':
      return false;
    case 'open':
      return !closedKeys(permissions).has(normalizeVolumeTitleKey(seriesTitle));
    default:
      return true;
  }
}

/**
 * An ownership 403 may mean this session's `closedSeries` is stale (bunko 0.8):
 * the identity is asked again, at most this often — every volume of a shared
 * folder can be refused, and most such refusals change nothing in `/me`.
 */
export const OWNERSHIP_REFRESH_MAX_AGE_MS = 60_000;

/** The ONE notice a backup gives for the volumes it skipped in closed series. */
export function closedSeriesNotice(series: number, volumes: number): string {
  if (volumes === 1)
    return 'Skipped 1 volume: its series belongs to another account on this server';
  if (series === 1) {
    return `Skipped ${volumes} volumes: their series belongs to another account on this server`;
  }
  return `Skipped ${volumes} volumes in ${series} series that belong to another account on this server`;
}

/** May this account move/rename existing server files? */
export function accountCanModifyDelete(status: Capabilities | null | undefined): boolean {
  return status?.canModifyDelete !== false;
}

/** One folded key per listed archive: series folder and stem, each folded like a title. */
function curatedVolumeKey(seriesTitle: string, volumeTitle: string): string {
  return `${normalizeVolumeTitleKey(seriesTitle)}\u0000${normalizeVolumeTitleKey(volumeTitle)}`;
}

/** Folded `curatedVolumes`, per list OBJECT: a fresh identity folds once, never per call. */
const curatedKeysByList = new WeakMap<CuratedVolume[], Set<string>>();

function curatedVolumeKeys(volumes: CuratedVolume[]): Set<string> {
  let keys = curatedKeysByList.get(volumes);
  if (!keys) {
    keys = new Set(volumes.map((v) => curatedVolumeKey(v.series, v.volume)));
    curatedKeysByList.set(volumes, keys);
  }
  return keys;
}

/**
 * May this account publish the volume `volumeTitle` of `seriesTitle` to the
 * shared `curated` layer? `all` anywhere; `owned` in a series this account
 * owns (`metadataPermissions.ownedSeries`, folded like the metadata gate: from
 * bunko 0.8 the series' RECORDED owner, who controls every volume in it), and
 * in a SHARED folder the volumes it uploaded (`curatedVolumes`: folder name +
 * archive stem, both folded; a local volume title folds onto its listed stem).
 * An older bunko lists no volumes: the owned series only. bunko stays the
 * judge — a 403 on the PUT is final. Anything else, including no curated
 * layer, no.
 */
export function canPublishCurated(
  status:
    | Pick<ProviderStatus, 'curatedPublish' | 'metadataPermissions' | 'curatedVolumes'>
    | null
    | undefined,
  seriesTitle: string,
  volumeTitle?: string
): boolean {
  switch (status?.curatedPublish) {
    case 'all':
      return true;
    case 'owned': {
      const key = normalizeVolumeTitleKey(seriesTitle);
      const owned = status.metadataPermissions?.ownedSeries ?? [];
      if (owned.some((title) => normalizeVolumeTitleKey(title) === key)) return true;
      const volumes = status.curatedVolumes;
      return (
        volumeTitle !== undefined &&
        !!volumes?.length &&
        curatedVolumeKeys(volumes).has(curatedVolumeKey(seriesTitle, volumeTitle))
      );
    }
    default:
      return false;
  }
}

/**
 * `canPublishCurated` for a volume row: takes the row whole, so a caller can
 * never ask by series alone and drop a shared-folder upload's Publish.
 */
export function canPublishCuratedVolume(
  status: Parameters<typeof canPublishCurated>[0],
  volume: { series_title: string; volume_title: string }
): boolean {
  return canPublishCurated(status, volume.series_title, volume.volume_title);
}

/**
 * The user-facing reason a rename was refused by the ACCOUNT's permissions
 * (read-only provider, no modify/delete role, a 403 on the MOVE), or null for
 * anything else (network, conflicts...) — which keeps its generic message.
 * A refusal is not a connection problem and must never be reported as one.
 */
export function renameRefusalMessage(error: unknown): string | null {
  if (!(error instanceof ProviderError)) return null;
  switch (error.code) {
    case 'NOT_PERMITTED':
    case 'PERMISSION_DENIED':
      return `Couldn't rename: ${CANNOT_RENAME_MESSAGE.charAt(0).toLowerCase()}${CANNOT_RENAME_MESSAGE.slice(1)}. Nothing was changed.`;
    case 'READ_ONLY':
      return `Couldn't rename: the cloud provider is read-only. Nothing was changed.`;
    default:
      return null;
  }
}
