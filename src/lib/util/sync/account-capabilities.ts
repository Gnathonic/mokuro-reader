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
import { ProviderError, type ProviderStatus } from './provider-interface';
import { normalizeVolumeTitleKey } from '$lib/metadata/series-key';

type Capabilities = Pick<ProviderStatus, 'canAddFiles' | 'canModifyDelete'>;

export const CANNOT_ADD_FILES_MESSAGE = "This account can't add files on this server";
export const CANNOT_RENAME_MESSAGE = "This account can't rename on this server";

/** May this account upload archives, sidecars and layer files, and create folders? */
export function accountCanAddFiles(status: Capabilities | null | undefined): boolean {
  return status?.canAddFiles !== false;
}

/** May this account move/rename existing server files? */
export function accountCanModifyDelete(status: Capabilities | null | undefined): boolean {
  return status?.canModifyDelete !== false;
}

/**
 * May this account publish `seriesTitle`'s volumes to the shared `curated`
 * layer? `all` anywhere; `owned` only in a series this account owns — bunko
 * grants it per uploaded VOLUME, approximated here by the series folder
 * (`metadataPermissions.ownedSeries`, folded like the metadata gate), so a
 * 403 on the PUT is final. Anything else, including no curated layer, no.
 */
export function canPublishCurated(
  status: Pick<ProviderStatus, 'curatedPublish' | 'metadataPermissions'> | null | undefined,
  seriesTitle: string
): boolean {
  switch (status?.curatedPublish) {
    case 'all':
      return true;
    case 'owned': {
      const key = normalizeVolumeTitleKey(seriesTitle);
      const owned = status.metadataPermissions?.ownedSeries ?? [];
      return owned.some((title) => normalizeVolumeTitleKey(title) === key);
    }
    default:
      return false;
  }
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
