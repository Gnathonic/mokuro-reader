# Filesystem Cloud Provider — Design

## Summary

Add a new cloud sync provider that uses the browser **File System Access API** to treat a local directory handle as a "cloud" endpoint. Users pick a folder once; subsequent sessions reuse the handle (permission permitting). Provider is hidden on browsers that don't support the API.

## Goals

- Offline, account-less backup target that fits the existing `SyncProvider` contract
- Zero changes to sync orchestration (`unified-sync-service`, `backup-queue`, workers) beyond wiring up the new type
- No read-only mode — the provider is either fully connected with read/write, or not connected at all
- No dependence on the main Dexie database — all filesystem-provider state lives in a dedicated IndexedDB database owned by the provider module

## Non-goals

- Worker-pool offload. The provider runs entirely on the main thread (`supportsWorkerDownload = false`). Local disk throughput does not benefit from worker parallelism here and it avoids structured-cloning `FileSystemDirectoryHandle` instances across postMessage.
- Syncing to arbitrary filesystem locations across the web; one handle per session, owned by the origin.
- Cross-origin use — origin-bound by API design.

## Browser support

The File System Access API ships in Chromium-based browsers (Chrome, Edge, Opera, Arc, Brave). Firefox and Safari expose neither `showDirectoryPicker` nor `FileSystemDirectoryHandle`.

Feature detection: `typeof window !== 'undefined' && 'showDirectoryPicker' in window`.

When unsupported:

- `CloudView.svelte` does not render the "Local Folder" option
- `loadProvider('filesystem')` throws with a clear message (defensive — should be unreachable when UI is gated)
- `provider-detection.ts` does not return `'filesystem'` from legacy detection (unsupported browsers can't have previously registered a handle)

## Authentication model

There is no credential string. "Login" = hold a valid `FileSystemDirectoryHandle` with `'granted'` readwrite permission.

### Login flow

1. User clicks "Connect Local Folder" in `CloudView`
2. Provider calls `window.showDirectoryPicker({ mode: 'readwrite' })`
3. On success, provider calls `handle.requestPermission({ mode: 'readwrite' })` to confirm readwrite — browsers sometimes grant the handle but not yet the permission
4. If permission is `'granted'`: persist the handle to IDB, set `active_cloud_provider = 'filesystem'`, mark authenticated
5. If permission is anything else, or the picker is cancelled: throw — no partial/read-only state is stored

### Session restore

On app startup with `active_cloud_provider === 'filesystem'`:

1. Open provider's IDB database, read the stored handle
2. Call `handle.queryPermission({ mode: 'readwrite' })`
3. If `'granted'`: mark authenticated, done
4. If `'prompt'`: leave provider in "configured but not connected" state. `CloudView` shows a **Reconnect folder** button that calls `handle.requestPermission({ mode: 'readwrite' })` inside the user-gesture handler. On grant → authenticated. On deny → treat as logout.
5. If `'denied'` or handle is missing/invalid: clear stored handle and `active_cloud_provider`, surface as logged-out

### Logout

- Delete handle from IDB
- Clear `active_cloud_provider`
- Null out in-memory state

## File layout

```
{pickedRoot}/
  volume-data.json
  profiles.json
  {SeriesTitle}/
    {VolumeTitle}.cbz
    {VolumeTitle}.mokuro.gz   (sidecar)
    {VolumeTitle}.webp        (thumbnail sidecar)
```

- No nested `mokuro-reader/` subfolder — the user already explicitly picked this directory. The provider treats the picked handle as the root.
- Sidecar filtering on list matches the WebDAV provider: include `.cbz`, `.mokuro`, `.mokuro.gz`, `.webp`, plus the two JSON config files at root.

## `SyncProvider` contract

| Field / method                                                | Value                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `type`                                                        | `'filesystem'`                                                                                  |
| `name`                                                        | `'Local Folder'`                                                                                |
| `supportsWorkerDownload`                                      | `false`                                                                                         |
| `uploadConcurrencyLimit`                                      | `4` (main-thread bound; same order as MEGA)                                                     |
| `downloadConcurrencyLimit`                                    | `4`                                                                                             |
| `isAuthenticated()`                                           | `rootHandle !== null`                                                                           |
| `getStatus()`                                                 | reports `isAuthenticated`, `hasStoredCredentials` (handle present in IDB), `isReadOnly` omitted |
| `login(credentials?)`                                         | ignores credentials; triggers picker (credentials param exists for interface conformance)       |
| `logout()`                                                    | delete IDB handle, null state                                                                   |
| `listCloudVolumes()`                                          | recursive walk via `directoryHandle.values()`                                                   |
| `uploadFile(path, blob)`                                      | traverse / create subdirs, `getFileHandle(name, { create: true })`, write via writable stream   |
| `downloadFile(file)`                                          | resolve stored file handle (or re-resolve from path), `handle.getFile()` → Blob                 |
| `deleteFile(file)`                                            | parent `.removeEntry(name)`                                                                     |
| `renameFile`                                                  | copy + delete (no native rename in API)                                                         |
| `renameFolder`                                                | recursive copy + recursive remove                                                               |
| `deleteSeriesFolder`                                          | `rootHandle.removeEntry(seriesTitle, { recursive: true })`                                      |
| `getStorageQuota()`                                           | `navigator.storage.estimate()` — origin quota, not disk free                                    |
| `getWorkerUploadCredentials` / `getWorkerDownloadCredentials` | not implemented (worker download disabled)                                                      |

`CloudFileMetadata.fileId` for this provider: the POSIX-style path relative to the picked root (e.g. `"SeriesTitle/Volume.cbz"`). The path is used to re-resolve file handles on demand; we don't cache live `FileSystemFileHandle`s in the metadata because they can become invalid if the user swaps the handle.

### Storage quota caveat

`navigator.storage.estimate()` reports the origin's persistent storage quota (typically a percentage of free disk, not the full disk). It does not reflect free space on the actual device. Document this in the provider info blurb so users don't expect "20 GB free" to mean their SSD has 20 GB.

## Files to add

```
src/lib/util/sync/providers/filesystem/
  filesystem-provider.ts    # implements SyncProvider
  filesystem-cache.ts       # Map<seriesTitle, CloudFileMetadata[]>, mirrors webdav-cache
  handle-store.ts           # Dedicated IDB: open('mokuro-filesystem-provider', 1), one object store 'handles', single row keyed 'root'
  feature-detect.ts         # isFilesystemProviderSupported()
```

All IDB interaction for this provider lives in `handle-store.ts`. The main Dexie database is untouched. The file exposes:

- `saveRootHandle(handle: FileSystemDirectoryHandle): Promise<void>`
- `loadRootHandle(): Promise<FileSystemDirectoryHandle | null>`
- `clearRootHandle(): Promise<void>`

## Files to modify

| File                                      | Change                                                                                                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/util/sync/provider-interface.ts` | Add `'filesystem'` to `ProviderType` union; add `isRealProvider` branch; add `FilesystemFileMetadata extends CloudFileMetadata` (no extra fields needed beyond base, but declared for discriminated-union completeness)                   |
| `src/lib/util/sync/provider-detection.ts` | Add `'filesystem'` to union guard in `getActiveProviderKey()`; no legacy detection branch (new provider, no migration path)                                                                                                               |
| `src/lib/util/sync/provider-manager.ts`   | Add `'filesystem': null` to status store's `providers` record in constructor and `updateStatus()`                                                                                                                                         |
| `src/lib/util/sync/init-providers.ts`     | New case in `loadProvider()` (dynamic import, feature-gated at call site); restore-credentials behavior matches MEGA/WebDAV (`await provider.whenReady()`)                                                                                |
| `src/lib/views/CloudView.svelte`          | New "Local Folder" button, gated on `isFilesystemProviderSupported()`; entries in `providerNames` and `providerInfo`; derived `filesystemAuth`; connected-state messaging; reconnect button when status is "configured but not connected" |

## Implementation detail: recursive listing

Unlike WebDAV (`Depth: infinity`), File System Access API requires manual recursion via `for await (const entry of handle.values())`. The provider exposes a single recursive walker that yields file metadata for any matching entry. Cache is repopulated from scratch each `fetch()` — no incremental invalidation for v1.

## Testing

- Unit tests for path parsing and layout helpers (pure functions, no API mocking needed)
- Manual browser testing: Chromium (happy path + revoked permission + picker cancelled); Firefox (verify button hidden); Safari (verify button hidden)
- Regression: ensure switching between filesystem ↔ WebDAV ↔ Google Drive still triggers correct logout of the previous provider

## Out of scope for this spec

- Syncing multiple folders simultaneously
- File watching / external-change detection (user edits files outside the app): cache is refreshed on next manual sync, matching existing providers
- Migration from WebDAV/MEGA to filesystem
