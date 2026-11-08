import type { UploadFileResult } from '$lib/util/sync/provider-interface';

/**
 * An upload is CONFIRMED by its own response (#288): a success status, and —
 * whenever the response reports the stored file's size — that size equals
 * the bytes sent. Every uploader runs its receipt through here before the
 * cache records it (`uploadCacheEntry`), so a short write is a failed upload,
 * never a cache entry that vouches for bytes the server does not hold.
 *
 * Where each size comes from: Drive's final resumable response (`fields=size`),
 * OneDrive's finished driveItem, the new MEGA node, Local Folder's `getFile()`
 * after the write. A WebDAV PUT answer carries no size; bunko's `X-Mokuro-Size`
 * is checked where the PUT is read (`webdav-upload.ts`). A receipt without a
 * size passes: the status is all that provider confirms.
 *
 * Content hashes are deliberately not compared here. WebCrypto has no
 * streaming digest, so hashing an archive means holding all of it in memory a
 * second time, per upload, in the backup workers; Drive's `md5Checksum` needs
 * an MD5 the platform lacks, and OneDrive's `quickXorHash` a hash of its own.
 * TLS already protects the bytes in transit, and a server that verifies
 * bodies end to end does it with `Content-Digest` (WebDAV `X-Mokuro-Put:
 * verified`).
 */
export function confirmUploadReceipt<T extends Pick<UploadFileResult, 'size'>>(
  receipt: T,
  sentBytes: number,
  provider: string
): T {
  const stored = receipt.size;
  if (typeof stored === 'number' && Number.isFinite(stored) && stored !== sentBytes) {
    throw new UploadNotConfirmedError(provider, stored, sentBytes);
  }
  return receipt;
}

/** The server reported a stored size other than the bytes sent. */
export class UploadNotConfirmedError extends Error {
  constructor(
    readonly provider: string,
    readonly storedBytes: number,
    readonly sentBytes: number
  ) {
    super(
      `${provider} upload not confirmed: the server stored ${storedBytes} of ${sentBytes} bytes`
    );
    this.name = 'UploadNotConfirmedError';
  }
}
