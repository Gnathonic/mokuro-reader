# OneDrive Cloud Provider — Design

## Summary

Add a new cloud sync provider that uses Microsoft Graph API to back up and sync manga volumes to OneDrive. Authentication uses **MSAL.js** with the `common` tenant so both personal Microsoft accounts and work/school accounts work from a single app registration. Direct worker-thread uploads and downloads (parallel to Google Drive/WebDAV) keep the WorkerPool's memory and concurrency gating intact.

## Goals

- Full-feature fourth real sync provider (parallel to Google Drive, MEGA, WebDAV) that plugs into the existing `SyncProvider` contract with no orchestration-layer changes
- Silent token refresh via MSAL — users don't get the popup-required re-auth UX that plagues Google Drive
- Work with both personal and organizational Microsoft accounts via a single app registration (`common` tenant)
- Worker-capable downloads and uploads so backups/restores get the same WorkerPool memory/concurrency throttling as Drive

## Non-goals

- SharePoint document libraries. `/me/drive` only; no `/sites/{id}/drives/{id}` routing.
- Shared folders owned by other users.
- Throttle-proof backoff strategies beyond what MSAL/Graph's 429 `Retry-After` header signals.
- Token introspection UI or multi-account switching. One authenticated account at a time, matching every other provider in the app.

## Browser support

OneDrive works anywhere Google Drive works: any reasonably modern browser that can perform `fetch`, `postMessage`, and popups. MSAL.js 3.x supports Chromium-based browsers, Firefox, and Safari.

No feature-gating needed — the button is always available in the UI.

## Authentication

### Library: MSAL.js (`@azure/msal-browser`)

**Why MSAL over a hand-rolled OAuth popup (the pattern Drive uses today):**

- Silent token refresh via hidden iframe + refresh tokens: the app can keep working across long reading sessions without throwing the user back into the picker
- Handles PKCE, state, and nonce correctly out of the box
- Handles redirect vs popup flows; handles tab-close edge cases; handles token cache location (sessionStorage vs localStorage)
- Microsoft-maintained; tracks Graph API and Azure AD changes

Bundle size cost: ~50 KB gzipped (msal-browser 3.x). Acceptable given the UX improvement over Drive's popup-refresh pattern.

### Configuration

- App registration: **Single-tenant-common (multi-tenant)** public SPA in Azure. User provides a client ID via `VITE_ONEDRIVE_CLIENT_ID` in `.env.local` — same pattern as `VITE_GDRIVE_CLIENT_ID`
- Authority: `https://login.microsoftonline.com/common` — accepts personal and work/school accounts
- Redirect URI: the app's origin (SPA flow, fragment-mode token return)
- Scopes: `Files.ReadWrite offline_access User.Read`
  - `Files.ReadWrite`: read + write user's OneDrive files
  - `offline_access`: get a refresh token so silent refresh works
  - `User.Read`: display name for status messaging (optional but cheap)

### Token lifecycle

- `login()`: `msalInstance.loginPopup(scopes)` returns an authentication result including `accessToken` (~1 hour) and a refresh token stored by MSAL
- Every API call wraps in `msalInstance.acquireTokenSilent({ scopes, account })` which returns a cached token if valid, auto-refreshes if not, falls back to popup if silent fails
- No `gdriveAutoReAuth`-style toggle needed — silent refresh is the default

### Logout

- `msalInstance.logoutPopup()` clears MSAL's cache and optionally navigates to MSFT sign-out page. We call the variant that doesn't navigate away (we just want local state cleared)
- Clear `active_cloud_provider` key
- Null out in-memory state

## File layout

```
/mokuro-reader/
  volume-data.json
  profiles.json
  {SeriesTitle}/
    {VolumeTitle}.cbz
    {VolumeTitle}.mokuro.gz      (sidecar)
    {VolumeTitle}.webp           (thumbnail sidecar)
```

Matches Google Drive and WebDAV. Root `/mokuro-reader` folder is created on first login if missing (same pattern as WebDAV's `/mokuro-reader` and Drive's named-parent lookup).

## Microsoft Graph API usage

Base URL: `https://graph.microsoft.com/v1.0`

| Operation                              | Endpoint                                                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whoami                                 | `GET /me` (for display name during status)                                                                                                                                               |
| List folder children                   | `GET /me/drive/root:/mokuro-reader:/children`                                                                                                                                            |
| Recursive listing                      | `GET /me/drive/root:/mokuro-reader:/search(q='')?$select=id,name,size,lastModifiedDateTime,file,parentReference` — returns all descendants with a path prefix filter applied client-side |
| Download                               | `GET /me/drive/items/{id}/content` (returns 302 to a short-lived `download.microsoft.com` URL)                                                                                           |
| Small upload (< 4 MB)                  | `PUT /me/drive/root:/{path}:/content`                                                                                                                                                    |
| Upload session (all sizes in practice) | `POST /me/drive/root:/{path}:/createUploadSession` → `PUT` chunks to `uploadUrl`                                                                                                         |
| Delete                                 | `DELETE /me/drive/items/{id}`                                                                                                                                                            |
| Move/rename                            | `PATCH /me/drive/items/{id}` with `{ name, parentReference: {id} }`                                                                                                                      |
| Create folder                          | `POST /me/drive/root:/{parent}:/children` with `{ name, folder: {}, @microsoft.graph.conflictBehavior: 'fail' }`                                                                         |
| Storage quota                          | `GET /me/drive` → `quota.{used, total, remaining}`                                                                                                                                       |

### Upload strategy

Use **resumable upload sessions for all files** (we never hit Graph with a simple PUT for CBZs). Reasons:

- Files under 4 MB are rare (mokuro sidecars only); using upload session is a small overhead
- Upload sessions recover from network drops and allow chunked progress reporting
- Chunk size 10 MiB is Graph's recommended size for SPA uploads
- `Content-Range` header on each chunk; Graph returns the finished `driveItem` JSON on the last chunk

### Listing strategy

Graph doesn't have a cheap "list all files under a folder recursively" primitive — `$search(q='')` returns a filter-friendly recursive result but its semantics are "search contents". More reliable: recursive `children` walk, like WebDAV's fallback path. We implement a recursive walker that follows `folder` children and yields `file` items whose paths pass `isSyncableFile` (reuse the filesystem provider's helper — extract to a shared location? See "Shared code" below).

## `SyncProvider` contract

| Field / method                         | Value                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `type`                                 | `'onedrive'`                                                                                                         |
| `name`                                 | `'OneDrive'`                                                                                                         |
| `supportsWorkerDownload`               | `true` (Graph supports Bearer-token downloads from any context)                                                      |
| `supportsWorkerUpload`                 | `true` (Bearer-token upload-session URLs are origin-agnostic)                                                        |
| `uploadConcurrencyLimit`               | `4` (Graph throttles at sustained >4 parallel writes per user)                                                       |
| `downloadConcurrencyLimit`             | `4`                                                                                                                  |
| `isAuthenticated()`                    | `msalInstance.getActiveAccount() !== null` and last token acquisition succeeded                                      |
| `getStatus()`                          | mirrors Drive — `isAuthenticated`, `hasStoredCredentials`, `needsAttention` if silent refresh is permanently failing |
| `login()`                              | MSAL `loginPopup`, then fetch quota to validate                                                                      |
| `logout()`                             | MSAL `logoutPopup` without navigation, clear active-provider key                                                     |
| `listCloudVolumes()`                   | recursive walk under `/mokuro-reader` via `children` + `isSyncableFile` filter                                       |
| `uploadFile(path, blob)`               | upload session with 10 MiB chunks + progress                                                                         |
| `downloadFile(file)`                   | `GET /items/{id}/content` with XHR progress (identical shape to Drive)                                               |
| `deleteFile(file)`                     | `DELETE /items/{id}`                                                                                                 |
| `renameFile`                           | `PATCH /items/{id}` (native move/rename — no copy-then-delete)                                                       |
| `renameFolder`                         | `PATCH /items/{id}` on the folder node                                                                               |
| `deleteSeriesFolder`                   | `DELETE /items/{id}` on the folder node (cascades)                                                                   |
| `getStorageQuota()`                    | `GET /me/drive` → quota object                                                                                       |
| `getWorkerUploadCredentials()`         | `{ accessToken }` acquired silently, plus optional `uploadSessionUrl` if pre-created in `prepareUploadTarget`        |
| `getWorkerDownloadCredentials(fileId)` | `{ accessToken }`                                                                                                    |

### `CloudFileMetadata.fileId`

The Graph `driveItem.id` string (opaque, stable across renames). Unlike the filesystem provider which used paths as fileIds, OneDrive items have stable IDs that survive renames — better matches Drive's model.

## Worker core adapter

New file `src/lib/util/sync/core/providers/onedrive-core.ts` implementing `CloudProviderCore` (the same interface Drive/MEGA/WebDAV satisfy). Runs inside the worker; receives `{ accessToken }` as credentials.

- `downloadFile({ fileId, credentials, onProgress })`: XHR-based Bearer-token fetch from `https://graph.microsoft.com/v1.0/me/drive/items/{fileId}/content`. Handles the 302 redirect to `download.microsoft.com` transparently (XHR follows it).
- `uploadFile({ seriesTitle, filename, blob, credentials })`: if `uploadSessionUrl` is provided in credentials, uploads chunks to it; otherwise creates a new session first. Returns the resulting item's `id`.

Registered in `cloud-provider-core-registry.ts` alongside the existing provider cores.

## Files to add

```
src/lib/util/sync/providers/onedrive/
  onedrive-provider.ts       # implements SyncProvider
  onedrive-cache.ts          # Map<seriesTitle, CloudFileMetadata[]>, mirrors webdav-cache
  onedrive-api-client.ts     # Thin typed wrapper over Microsoft Graph endpoints this provider uses
  token-manager.ts           # MSAL lifecycle: init, login, logout, acquireTokenSilent with the right scopes
  constants.ts               # VITE_ONEDRIVE_CLIENT_ID, authority, scopes, folder names

src/lib/util/sync/core/providers/
  onedrive-core.ts           # CloudProviderCore impl for worker-thread downloads and uploads
```

## Files to modify

| File                                                                | Change                                                                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                                      | Add `@azure/msal-browser` to dependencies                                                                                                |
| `src/lib/util/sync/provider-interface.ts`                           | Add `'onedrive'` to `ProviderType`, add `OneDriveFileMetadata`, add to `AnyCloudFileMetadata`, extend `isRealProvider`                   |
| `src/lib/util/sync/provider-detection.ts`                           | Add `'onedrive'` to `getActiveProviderKey` type guard. No legacy-credentials branch — the provider is new, nothing to migrate from       |
| `src/lib/util/sync/provider-manager.ts`                             | Add `onedrive: null` to status store provider records (two spots)                                                                        |
| `src/lib/util/sync/init-providers.ts`                               | Dynamic-import case in `loadProvider`; no `whenReady` entry (MSAL reads state synchronously from its cache during provider construction) |
| `src/lib/util/sync/core/cloud-provider-core-registry.ts`            | Register `onedriveCore`                                                                                                                  |
| `src/lib/types/index.ts`                                            | No change — `cloudProvider` field is already `ProviderType` after the filesystem-provider work                                           |
| `src/lib/views/CloudView.svelte`                                    | New "OneDrive" provider button; `providerNames` + `providerInfo` entries; derived `onedriveAuth`; login/logout handlers                  |
| `src/lib/util/backup-queue.ts` and `src/lib/util/download-queue.ts` | No change — OneDrive sets both worker flags to `true`, so it takes the existing worker-driven code paths used by Drive/MEGA/WebDAV       |

## Error handling

| Graph status                                  | Handling                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 401                                           | Acquire token silently; if that also fails, mark `needsAttention`, trigger MSAL popup                 |
| 403 (quota exceeded or permission denied)     | Bubble as `ProviderError` with `PERMISSION_DENIED` or `QUOTA_EXCEEDED`                                |
| 404 (file not found)                          | For `deleteFile`/`deleteSeriesFolder`: treat as idempotent success. For others: bubble as `NOT_FOUND` |
| 423 (resource locked — folder being modified) | Retry once after 1s; then bubble                                                                      |
| 429 (throttled)                               | Honor `Retry-After` header, retry up to 3 times with exponential backoff                              |
| 5xx                                           | Same retry policy as 429                                                                              |
| Network failure during upload session         | Use Graph's `GET {uploadUrl}` to query progress, resume from last acknowledged range                  |

Reuse the existing MEGA/WebDAV `ProviderError` patterns.

## Storage quota

`GET /me/drive` returns a `quota` object with `used`, `total`, `remaining`, `state`. Map directly to `StorageQuota`:

```typescript
{ used: quota.used, total: quota.total, available: quota.remaining }
```

## Testing

- Unit tests for the MSAL adapter (token acquisition flow, mocking MSAL responses)
- Unit tests for the Graph API client (mock `fetch` / `XMLHttpRequest` with happy path + 401/404/429 fixtures)
- Upload-session chunking tests (ensure correct `Content-Range` headers, handle the final-chunk response shape)
- Manual end-to-end: backup + restore + rename + delete + storage-quota display with a real personal OneDrive and a real work/school account

## Shared code opportunity (out of scope for v1)

Both the filesystem provider and (soon) OneDrive have a `isSyncableFile` helper with identical semantics. Noted as future tidy: extract to `src/lib/util/sync/syncable-files.ts`. Leave duplicated for v1 to keep the scope focused on "add OneDrive" and not "refactor all providers."

## Out of scope for this spec

- SharePoint / Teams files
- Shared-with-me folders
- Multi-account switching
- Explicit "share link" generation for collaboration
- Personal Vault directory (skipped during listing — Graph's default listing excludes it anyway)
