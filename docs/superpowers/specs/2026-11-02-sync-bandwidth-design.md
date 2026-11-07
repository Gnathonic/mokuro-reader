# Sync bandwidth per page turn

Status: approved direction (owner, 2026-11-02: "Do it"). This document is the binding brief for the work
on `feat/sync-bandwidth`. It refines rollout steps 2 and 4 of `2026-10-16-sync-tiers-design.md` and
issue #288.

## Goal

A page turn on a metered connection should cost little more than this device's own small
`positions.json` write. While reading, the periodic progress sync should cost a few tiny metadata
requests when nothing changed, not the download of every root file.

Baseline (`e2e/sync-bandwidth.spec.ts`, WebDAV stub, 300 read volumes; request + response bodies):

| Window                       | Requests | Up    | Down  |
| ---------------------------- | -------- | ----- | ----- |
| W1 turn + positions push     | 7        | 24 KB | 25 KB |
| W2 turn + full progress sync | 17       | 29 KB | 60 KB |
| W3 idle progress sync        | 6        | 0     | 57 KB |

On Google Drive every `volume-data.json` / `profiles.json` / `goals.json` upload also re-lists the
whole account (13+ `files.list` pages at ~12k files), which the stub does not model.

## Part A: receipts and conditional root-file reads (every provider)

The content of a root file read is unchanged; only the transport changes. No merge rule moves.

1. **Stat verb.** `SyncProvider.statFile?(file: CloudFileMetadata): Promise<FileStamp | null>` — the
   server's current stamp of ONE known file, without its body; `null` = gone (not found). `FileStamp =
{ size: number; modifiedTime: string; revision?: string }`. `revision` is the strongest
   provider-opaque change token available; `size` + `modifiedTime` are always filled.
   - WebDAV: PROPFIND Depth 0 on the file (`client.stat`): `etag` → `revision`, `lastmod`, `size`.
     Never a custom `If-None-Match` header (plain servers' CORS allow-lists refuse unknown request
     headers; a refused preflight looks like a network failure).
   - Google Drive: `files.get(fileId, fields='id,size,modifiedTime,version,md5Checksum')`.
     `revision` = `version` (monotonic; any change bumps it).
   - OneDrive: `GET /me/drive/items/{id}?$select=id,size,lastModifiedDateTime,eTag,cTag`.
     `revision` = `cTag` (content changes only), else `eTag`.
   - MEGA: the in-memory node (`nodeId`, `timestamp`, `size`), no request. A different node id for
     the path means a different revision (uploads mint new nodes). Trust only while the `sc` poll is
     alive: with no poll running (one that gave up recovering) the stat throws, so the read
     downloads, and a node another device replaced fails ENOENT there, which reloads the tree.
   - Local Folder: `getFile()` → `lastModified`, `size`.
2. **Receipts.** `UploadFileResult` gains optional `revision?: string`, and for Drive `parentId?`
   and `name?`. Each provider fills what its upload response already carries (Drive: widen the
   resumable session `fields=` to `id,name,size,modifiedTime,version,parents`; OneDrive: the final
   item's `eTag`/`cTag`, but NONE when the item came from the lost-ack probe (a same-size file at
   the path proves nothing about whose bytes it holds); WebDAV: the PUT response's `ETag` header when readable, else NO revision —
   never a stat after the PUT, which could see another device's write landing in between and bind
   our bytes to its revision; MEGA: the node; Local Folder: the stat it already does). `uploadCacheEntry` carries them into the cache entry.
   `unifiedCloudManager.uploadFile` / `blindUploadFile` return the full `UploadFileResult` (callers
   that used the id string are updated). `positions-sync.ts` stops re-adding a degraded cache entry
   after the blind upload (the manager already added the receipt).
3. **Read memo.** A new module (`src/lib/util/sync/root-file-memo.ts`) keeps, IN MEMORY per provider
   type + account scope + fileId: `{ stamp: FileStamp, bytes: Uint8Array }` of the last copy this
   device read or wrote. `readRootFile(provider, file)` → `Blob`:
   - If a memo exists and `provider.statFile` exists: stat; if the stamp equals the memo's
     (`revision` when both have one, else `size` AND `Date.parse(modifiedTime)`), return the memo's
     bytes — no download. A `null` stat throws the provider's NOT_FOUND (same as a download of a
     gone file).
   - Otherwise download as today, then stat (or reuse the stat taken before the download — sample
     the stamp BEFORE the body so a racing write costs a re-download, never a stale "fresh") and
     memoize.
   - After this device's own upload of a root file with a receipt that has `modifiedTime`+`size`
     (and `revision` when the provider can give one), memoize the uploaded bytes under the receipt's
     stamp. No receipt stamp → drop the memo for that fileId (the next read downloads once).
   - Root files only: `volume-data.json`, `profiles.json`, `goals.json`, `positions.json`. Bounded
     (a handful of entries); cleared on logout / provider switch / cache clear.
   - Used by every download of those files in `unified-sync-service.ts` and `positions-sync.ts`
     (including each copy when duplicates exist).
4. **WebDAV listings** keep `etag` (`getetag`) on entries (`WebDAVFileMetadata.etag`, and as
   `revision`).
5. **Small WebDAV costs on the push path:** memoize a successful `ensureMokuroFolder` per session
   (cleared on logout/login) for UPLOADS only — every listing still asks, so a reader folder
   deleted on the server is made again; when the caller already knows the file's size (memo or stat), the
   download may skip its HEAD probe.

## Part B: page turns stop re-uploading volume-data.json

Rejected: the spec's full split (position leaves `volume-data.json`, per-record `updatedAt`). The map
found `volume-data.json` is the only long-term position carrier once a `positions.json` entry ages out
(30 days) and the only safety net for a lost `positions.json` write; the split needs an age-out
closure, escape tracking of a second stamp and per-field merge keys. Same bandwidth, no merge change:

**Defer position-only uploads during a reading session.** In `syncVolumeData`, when the merged file
differs from the cloud copy ONLY by position-only changes, skip the upload while a reading session is
active. The upload happens at the end of the session (the activity tracker's flush on leaving the
reader / tab hidden already runs a sync — that sync is NOT in session and uploads), and on every sync
outside a session. Nothing about the merge or the file format changes.

- **Reading session active** = the reader is open on a volume AND the document is visible
  (`positions/reader-open.ts` `openReader()` + `document.visibilityState`). The flush that ends a
  session must see "not active" (close/hide happen before it runs) — make that ordering explicit.
- **Position-only** = for every volume whose record differs between the next file and the cloud
  (survivor) copy, the difference is confined to `progress`, `chars` and `lastProgressUpdate`;
  both sides have `progress > 0`; and the record exists on both sides. Any other field (`completed`
  included: a `positions.json` entry carries no flag, and a device adopting one keeps its own for
  a volume it does not have open), any series/tracking-section difference, any added/removed
  record → not position-only.
- **Covered** = additionally all of: `historySyncAllowed(status)`, `!status.isReadOnly`,
  `positionsWriteAllowed(status)`, the provider holds legacy turns (`legacyCarriedBy` — otherwise
  the file still carries turns), and each such volume's position is on its way through
  `positions.json` (it is in `changedVolumes()` with a mark EQUAL to the record's stamp — the push
  sends only those, and a look-up restore leaves a mark above it — OR the cloud `positions.json`
  entry has `t >=` the record's stamp). Not covered → upload as today.
- The escape reporting at upload (`noteUploaded` for watched visits) stays exactly where it is: it
  runs whenever the upload runs. A deferred upload reports nothing (nothing left).
- Log at debug when an upload is deferred, with the count of volumes.

## Part C: #288 on Google Drive

1. `uploadFile` no longer re-lists the account: it is the blind upload plus the receipt
   (`parentId`, `name`, `revision`). Update the test that pins the refetch and the ruling comment in
   `unified-cloud-manager.ts` about which callers may use the blind path.
2. **Change feed** in `DriveFilesCacheManager`: take `changes.getStartPageToken` BEFORE each full
   `files.list` walk; keep the folder map (`id → {name, parent}`) on the instance;
   `refreshFromChanges(): Promise<'unchanged' | 'applied' | 'reset'>` pages `changes.list`
   (`pageSize` 1000, `includeRemoved`, fields incl. `file(id,name,mimeType,modifiedTime,size,
parents,description,trashed,ownedByMe,version)`), applies owned upserts/removals with the same
   classification and path rules as the full fetch (series files, root config under the reader
   folder, history via `driveHistoryPath`, folder renames re-path children), through the cache's
   mutation path with the newer-revision rule, without toggling `fetching`/`loaded`, and without
   re-emitting when nothing changed (echo of our own write). Unknown parent folders: one
   `files.get(parent, 'id,name,parents')`. Any token error, a `cacheGeneration` change, or a cache
   older than 24 h → `'reset'` → full fetch. A folder upsert that collides with a same-name folder
   under the same parent triggers the existing deduplication.
3. **Where it runs:** at the top of `runProviderSync` for Drive (before volume data), and in place
   of the full listing in `ensureFreshCloudListing` on Drive. The backup run's single post-run fetch
   stays.
4. Behaviour not verified without a real account (record in the PR): `drive.file` feed visibility of
   another device's writes, the invalid-token status code, folder-move entries. The full-fetch
   fallback covers any feed failure. Known edge, accepted: the position is taken just before the
   walk, so a file written seconds before it that Drive's eventually consistent `files.list` does not
   yet return is in neither the walk nor the feed; the 24 h safety-net listing (or any full listing)
   brings it. Before #288 the next upload's re-listing healed it sooner.
5. A full listing never drops the feed's position before it runs: a listing that fails (offline)
   leaves the cache the snapshot at that position, so the next refresh catches up with one feed read.

## Testing

- Unit: `statFile` + receipt per provider; the memo (unchanged → no download, changed → download,
  receipt seeding, no-stamp receipt drops the memo, duplicates read per copy, NOT_FOUND); the
  deferral rule (each clause, both directions; session end uploads); the Drive feed (apply, echo
  idempotence, folder rename, reset → full fetch, dedup trigger) and no refetch after `uploadFile`.
- e2e: `sync-bandwidth.spec.ts` asserts budgets after the change (the WebDAV stub gains `getetag`,
  an `ETag` header on GET/HEAD/PUT); a two-device spec: device B sees A's page through
  `positions.json` mid-session while `volume-data.json` is not uploaded, and gets it in
  `volume-data.json` after A leaves the reader.
- Every existing unit and e2e test stays green; zero failures expected.
