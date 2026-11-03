/**
 * The root-file read memo: the bytes of the last copy of each small root file
 * (`volume-data.json`, `profiles.json`, `goals.json`, `positions.json`) this
 * device read or wrote, kept IN MEMORY under the server stamp they had.
 *
 * Every progress sync and position push reads those files whole, and the
 * cached listing cannot say whether another device changed one since (it is
 * refreshed only at startup and around renames). So `readRootFile` asks the
 * server for the file's CURRENT stamp first (`SyncProvider.statFile`, one
 * small metadata request — MEGA and Local Folder need none) and returns the
 * memo's bytes when the stamp is the one they were read under. What a caller
 * gets is exactly what a download would have returned; only the transport
 * changes, so no merge rule moves.
 *
 * Safety rules:
 * - Only a provider CHANGE TOKEN (`FileStamp.revision`: Drive `version`,
 *   OneDrive `cTag`/`eTag`, a WebDAV `getetag`, a MEGA node id) can say
 *   "unchanged". Size + modification time cannot: WebDAV's `getlastmodified`
 *   has one-second precision, and two devices' same-size writes within one
 *   second (two positions or progress pushes; the e2e suite does it every
 *   run) would read as one revision, and the newer write would be lost to
 *   this device's merge. A provider that gives no token (a WebDAV server
 *   without `getetag`, Local Folder) is read as before: after one stat shows
 *   no token, its reads go straight to the download for the session.
 * - The stamp is sampled BEFORE the body. A write racing the download then
 *   leaves the memo under the OLD stamp with possibly newer bytes, and the
 *   next read sees a different stamp and downloads again — a racing write
 *   costs a re-download, never a stale "unchanged".
 * - This device's own upload seeds the memo only from the upload RECEIPT's
 *   server stamp (`noteRootFileUpload`). A receipt without one drops the
 *   memo for that file, so the next read downloads once.
 * - Keyed by provider type + account scope + file id: duplicate copies (Drive
 *   lists same-name files) are memoized and read one by one. A provider that
 *   cannot name its account is never memoized.
 * - Bounded, and cleared on logout, provider switch and cache clear
 *   (`cacheManager.clearAll` / `setActiveProvider`).
 */

import {
  ProviderError,
  type CloudFileMetadata,
  type FileStamp,
  type SyncProvider,
  type UploadFileResult,
  type UploadPayload
} from './provider-interface';

/** The root files whose reads go through the memo. */
export const MEMO_ROOT_FILES: ReadonlySet<string> = new Set([
  'volume-data.json',
  'profiles.json',
  'goals.json',
  'positions.json'
]);

/** Is `path` (relative to the reader root) one of the memoized root files? */
export function isMemoRootFile(path: string): boolean {
  return MEMO_ROOT_FILES.has(path.replace(/^\/+/, ''));
}

/** Enough for every copy of four files with a few Drive duplicates. */
const MAX_ENTRIES = 16;

/**
 * A memo's stamp. `modifiedTime` may be absent when the stamp came from an
 * upload receipt that carried only a change token (a WebDAV PUT's `ETag`).
 */
interface MemoStamp {
  size: number;
  modifiedTime?: string;
  revision?: string;
}

interface MemoEntry {
  stamp: MemoStamp;
  bytes: Uint8Array;
}

const memo = new Map<string, MemoEntry>();

/** Provider accounts whose stats carry no change token: never memoized (see the module doc). */
const revisionless = new Set<string>();

function accountKey(provider: SyncProvider): string | null {
  let scope: string | undefined;
  try {
    scope = provider.getStatus().accountScope;
  } catch {
    scope = undefined;
  }
  return scope ? `${provider.type}\u0000${scope}` : null;
}

function memoKey(provider: SyncProvider, fileId: string): string | null {
  const account = accountKey(provider);
  if (!account || !fileId) return null;
  return `${account}\u0000${fileId}`;
}

function remember(key: string, entry: MemoEntry): void {
  memo.delete(key); // re-insert: Map order is the eviction order
  memo.set(key, entry);
  while (memo.size > MAX_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/**
 * Is `current` (the server, now) the revision `held` was read under? Only
 * when both carry the same change token and the same size — never on size +
 * modification time alone (see the module doc). Anything less is "changed":
 * a false "changed" costs one download, a false "unchanged" would hide
 * another device's write.
 */
export function sameStamp(held: MemoStamp, current: FileStamp): boolean {
  if (held.size !== current.size) return false;
  return !!held.revision && !!current.revision && held.revision === current.revision;
}

function notFound(provider: SyncProvider, file: CloudFileMetadata): ProviderError {
  return new ProviderError(`File not found: ${file.path}`, provider.type, 'NOT_FOUND');
}

async function statOrUndefined(
  provider: SyncProvider,
  file: CloudFileMetadata
): Promise<FileStamp | null | undefined> {
  try {
    return await provider.statFile!(file);
  } catch (error) {
    // A stat that failed for another reason than "gone" says nothing: the
    // download runs as before and reports whatever is really wrong.
    console.debug('[root-file-memo] stat failed, downloading instead:', error);
    return undefined;
  }
}

/**
 * Read one listed copy of a root file — the same bytes `provider.downloadFile`
 * would return, downloaded only when the server's stamp moved since this
 * device last read or wrote that copy. A file the server reports gone throws
 * the provider's NOT_FOUND, like a download of a gone file.
 */
export async function readRootFile(provider: SyncProvider, file: CloudFileMetadata): Promise<Blob> {
  const key = provider.statFile ? memoKey(provider, file.fileId) : null;
  if (!key) return provider.downloadFile(file);
  const account = accountKey(provider)!;
  if (revisionless.has(account)) return provider.downloadFile(file);

  const stamp = await statOrUndefined(provider, file);
  if (stamp === null) {
    memo.delete(key);
    throw notFound(provider, file);
  }
  if (stamp === undefined) return provider.downloadFile(file);

  const held = memo.get(key);
  if (held && sameStamp(held.stamp, stamp)) {
    remember(key, held);
    return new Blob([held.bytes as BlobPart], { type: 'application/json' });
  }

  const blob = await provider.downloadFile(file, undefined, { knownSize: stamp.size });
  if (!stamp.revision) {
    // Nothing to compare against next time: read as before from now on.
    revisionless.add(account);
    memo.delete(key);
    return blob;
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Under the stamp sampled BEFORE the body (see the module doc).
  remember(key, { stamp: { ...stamp }, bytes });
  return new Blob([bytes as BlobPart], { type: blob.type || 'application/json' });
}

async function payloadBytes(payload: UploadPayload): Promise<Uint8Array> {
  // Shape tests, not `instanceof`: a payload can come from another realm.
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(
      payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
    );
  }
  if (Object.prototype.toString.call(payload) === '[object ArrayBuffer]') {
    return new Uint8Array((payload as ArrayBuffer).slice(0));
  }
  return new Uint8Array(await (payload as Blob).arrayBuffer());
}

/**
 * This device just wrote `payload` to `path`: memoize those bytes under the
 * receipt's server stamp, so the next read of the file costs a stat, not a
 * download. A receipt with no change token (or a server size that disagrees
 * with the bytes sent) drops the memo for that file instead. Paths other
 * than the memoized root files are ignored.
 */
export async function noteRootFileUpload(
  provider: SyncProvider,
  path: string,
  payload: UploadPayload,
  uploaded: Pick<UploadFileResult, 'fileId' | 'modifiedTime' | 'size' | 'revision'>
): Promise<void> {
  if (!isMemoRootFile(path) || !uploaded?.fileId) return;
  const key = memoKey(provider, uploaded.fileId);
  if (!key) return;
  const bytes = await payloadBytes(payload);
  // A change token alone (a WebDAV PUT's ETag) vouches for exactly the bytes
  // sent; a server size that disagrees with them vouches for nothing.
  const size = uploaded.size ?? bytes.byteLength;
  if (!uploaded.revision || size !== bytes.byteLength) {
    memo.delete(key);
    return;
  }
  remember(key, {
    stamp: {
      size,
      ...(uploaded.modifiedTime ? { modifiedTime: uploaded.modifiedTime } : {}),
      ...(uploaded.revision ? { revision: uploaded.revision } : {})
    },
    bytes
  });
}

/** Forget every memoized file (logout, provider switch, cache clear). */
export function clearRootFileMemo(): void {
  memo.clear();
  revisionless.clear();
}

/** Test seam: how many files are memoized. */
export function rootFileMemoSize(): number {
  return memo.size;
}
