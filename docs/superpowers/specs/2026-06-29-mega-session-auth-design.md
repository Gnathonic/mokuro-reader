# MEGA Session-Token Auth, 2FA, and Worker Hardening — Design

**Date:** 2026-06-29
**Branch:** `feat/mega-session-auth` (based on `develop`)
**Status:** Approved design → implementation planning

## Problem

The MEGA cloud-sync provider has three coupled issues, all rooted in how it authenticates:

1. **Plaintext password storage.** Credentials are stored as plaintext `mega_email` + `mega_password`
   in `localStorage` (`mega-provider.ts:21-25`, save at `:230-233`). A full
   `new Storage({ email, password })` login runs on **every** app load, manual connect, and cache
   refresh (`reinitialize()`), creating a brand-new MEGA session each time. The password is the most
   dangerous secret possible — it grants permanent, full account control (change email/password,
   disable 2FA, delete account) and never expires.

2. **No 2FA support.** Because login replays the stored password on every reload, there is no way to
   support two-factor accounts: a single-use TOTP code cannot be replayed. There is no 2FA handling
   or UI anywhere today.

3. **Hacky worker file access.**
   - *Downloads* use a **public share-link workaround**: the main thread mints a `file.link()` URL
     (decryption key embedded), ships `megaShareUrl` to the worker, the worker downloads anonymously
     via `MegaFile.fromURL`, then the main thread tears the link down with `unshare()`
     (`mega-provider.ts:1011-1088`, `mega-core.ts:53-67`). A mutex + 200 ms throttle gates link
     creation. This briefly exposes every downloaded file as a public URL.
   - *Uploads* hand the **plaintext password** to the worker (`getWorkerUploadCredentials()` →
     `{ megaEmail, megaPassword }`, `mega-provider.ts:1197-1202`), which spins up its own full
     `Storage`.

## Goal

Replace password storage with a reused, revocable **session token**; add **2FA** login; and replace
both worker hacks with lightweight, session-based file access — without leaving any plaintext
password in storage or in worker messages.

## Library constraints (megajs 1.3.9, verified against installed source)

These facts, verified against `node_modules/megajs/dist/*` and `types/cjs.d.ts`, drive the design.

- **Session persistence is via `storage.toJSON()` / `Storage.fromJSON()`** — there is **no**
  `sessionID` constructor option, no `Storage.fromSession`, no `'login'` event.
  - `storage.toJSON()` → `{ sid, key, user, name, options }` (`main.node-cjs.js:2275-2283`).
  - `Storage.fromJSON(json)` rebuilds an authenticated `Storage` with **zero network calls**,
    forcing `autoload:false` + `autologin:false` and injecting `sid` into the API layer
    (`:2284-2295`).
- **⚠ The persisted blob contains the account master key (`key`), not just a session id.** The bare
  `sid` authenticates raw API calls but cannot decrypt owned-file keys — that needs the master key,
  derivable only from the password at login time. So the stored "token" is still a sensitive secret.
  It is nonetheless **meaningfully safer than the password**: the session is server-revocable, and it
  **cannot** change the account password/email or disable 2FA (those require the password). The
  serialized blob does **not** contain the password (deleted by the lib at login,
  `:2088`). **Accepted tradeoff** — there is no lower-privilege artifact in this library.
- **2FA is supported.** `new Storage({ email, password, secondFactorCode })` → maps to the `us`
  command's `mfa` field (`:2087-2091`). "2FA required" is signaled **only** by an error message
  containing `EMFAREQUIRED` / `-26` / `Multi-Factor` (`:804`, `:884-892`) — no numeric `.code`
  property; the caller must string-match.
- **Lightweight sessions are supported.** `autoload:false` authenticates (gets `sid` + master key)
  without fetching the file tree (`:2055-2068`); `fromJSON()` is lighter still (no network at all,
  no keepalive long-poll).
- **Owned-node download by id is possible without the tree.** `File.download` issues an
  authenticated `{ a:"g", g:1, n:<nodeId> }` when `file.nodeId` is set, authorized by `api.sid`
  (`:1140-1158`, `:856-857`). Construct `new File({ downloadId: nodeId, key, api })`, force
  `file.nodeId = nodeId`, call `downloadBuffer()`. **No share link, and the master key is not needed
  in the download worker** — only `sid` + the per-file key.
- **Session invalidation** surfaces as `ESID (-15): Invalid or expired user session, please relogin`
  (`:798`).
- The browser build (`main.browser-es.mjs`) is at parity for all of the above (`fromJSON`,
  `secondFactorCode`, `sid`, `EMFAREQUIRED`).

## Design

### A. Stored artifact (replaces `mega_email`/`mega_password`)

- New `localStorage` key **`mega_session`** = `JSON.stringify(storage.toJSON())`.
  - Before persisting, sanitize `blob.options` to drop `secondFactorCode` (single-use) and any
    `password` residue. Email remains in `blob.options.email` — used for status display and
    reconnect pre-fill, so **no separate `mega_email` key is required going forward.**
- On migration, **remove** the legacy `mega_email` and `mega_password` keys.
- Stored plaintext, consistent with the existing `gdrive_token` pattern
  (`google-drive/token-manager.ts`). Encrypting-at-rest is **out of scope**: there is no user secret
  to derive a key from, and both `localStorage` and IndexedDB are equally readable by same-origin JS.

### B. Login & restore (main thread — `mega-provider.ts`)

- **Fresh interactive login** `login({ email, password, secondFactorCode? })`:
  `new Storage({ email, password, secondFactorCode, autoload: true })` → `await ready` →
  `ensureMokuroFolder()` → capture `toJSON()`, sanitize, write `mega_session`, remove legacy keys,
  `setActiveProviderKey('mega')`.
- **Restore** `restoreSession(blob)`: `Storage.fromJSON(blob)` (no network, no password) → then
  `storage.reload()` to load the file tree the main thread needs for listing/upload/rename/delete.
  This **replaces today's full re-login-on-every-load**: no password, the session is reused, and we
  do one tree fetch instead of a login round-trip + tree fetch.
- **`reinitialize()`** (cache-staleness refresh) calls `storage.reload()` on the existing session
  instead of a fresh `login()`. Must confirm `reload()` refreshes `storage.files` (verification #1).
- **Error discrimination** (unchanged philosophy): transient/network errors keep `mega_session` and
  retry; genuine auth/session failures route to needs-attention (§D).

### C. 2FA — two-step, reveal-on-demand

- Provider: in `login()`, catch the login rejection; if its message matches
  `/EMFAREQUIRED|-26|Multi-Factor/i`, rethrow a **typed** `ProviderError` with a stable
  `code: 'MFA_REQUIRED'` (and `isAuthError: false`) so the UI branches on a code, not a string.
- UI (`CloudView.svelte`): MEGA form shows email + password only. On `MFA_REQUIRED`, keep
  email/password in component state, set `megaNeeds2fa = true`, reveal a 6-digit code `<input>`
  (`bind:value={megaTwoFactorCode}`), and resubmit `login({ email, password, secondFactorCode })`.
  The code is **never** persisted. On success, clear all fields including the code.
- `provider-interface.ts`: document `secondFactorCode` in the `ProviderCredentials` comment; add the
  `MFA_REQUIRED` code to the `ProviderError` conventions.

### D. Session loss / needs-attention (no stored password)

- Detect `ESID (-15)` (message match) on any authenticated operation → `markSessionExpired()`:
  remove `mega_session`, set an internal `needsAttention` flag, retain the email (parsed from the old
  blob before clearing, or held in memory) for reconnect pre-fill.
- `getStatus()` returns `{ isAuthenticated:false, needsAttention:true, statusMessage:'MEGA session
  expired — please reconnect' }`.
- `CloudView.svelte` renders a reconnect prompt (pre-filled email) when MEGA needs attention,
  reusing the WebDAV needs-attention UI scaffolding (`CloudView.svelte:55-60`, `:113-115`,
  `:693-697`) extended to MEGA. MEGA has no needs-attention UI today, so this is net-new wiring.
- Because no password is stored, reconnect always goes through the full login form (+ 2FA if
  required). MEGA sessions are long-lived, so this is rare in practice.

### E. Migration (existing users)

In the restore path (`loadPersistedCredentials` → renamed/reworked `restorePersistedSession`):

1. If `mega_session` present → `restoreSession(blob)`.
2. Else if legacy `mega_email` + `mega_password` present → silent `login({ email, password })`. On
   success this writes `mega_session` and deletes the legacy keys (in-place upgrade). On
   `MFA_REQUIRED` (account enabled 2FA since the password was stored) → `markSessionExpired()` /
   needs-attention reconnect. On genuine auth failure → clear + needs-attention. On transient error →
   keep legacy keys for retry.
3. Else → unauthenticated.

- `provider-detection.ts`: `detectProviderFromCredentials()` recognizes `mega_session` **or** the
  legacy pair (so a not-yet-migrated user is still detected as MEGA).
- `provider-manager.ts`: `logout()` hard-clear list removes `mega_session` **and** the legacy
  `mega_email`/`mega_password`/`mega_folder_path`.

### F. Worker downloads — remove share links (Phase 2)

*Verified: `createShareLink`/`deleteShareLink` have no callers outside the worker-download path, so
the entire share-link mechanism can be removed.*

- `getWorkerDownloadCredentials(fileId)`: from the already-loaded tree, locate the node and return
  **`{ sid, nodeId, fileKey }`** — the session id, node id, and the node's already-decrypted per-file
  key (base64). **No share link, no master key in the download worker.** Drop the
  mutex/`workerShareLinkMutex`/`WORKER_SHARE_LINK_THROTTLE_MS`/`workerShareLinksToCleanup`.
- `mega-core.downloadFile`: build a lightweight, per-`sid`-cached api
  (`new Storage({ autologin:false, autoload:false })`; set `api.sid = sid`), then
  `new File({ downloadId: nodeId, key: fileKeyBuffer, api })`, force `file.nodeId = nodeId`, call
  `downloadBuffer()` (with progress). Remove the `MegaFile.fromURL(shareUrl)` path.
- `cleanupWorkerDownload(fileId)` becomes a no-op (or is removed); `download-queue.ts` cleanup
  branches for MEGA are removed.
- Remove `createShareLink` / `deleteShareLink` and the `megaShareUrl` credential.

### G. Worker uploads — remove password (Phase 1 — forced by §A)

*This lands in Phase 1, not Phase 2: §A deletes the stored password, but the upload worker currently
reads `mega_email`/`mega_password`. Once the password is gone, the upload path must already use the
session blob. (Download share links, §F, are unaffected — they use the main-thread session, which
keeps working post-migration — so only §F is deferrable to Phase 2.)*

- `getWorkerUploadCredentials()`: return **`{ megaSession: <sanitized toJSON blob> }`** instead of
  `{ megaEmail, megaPassword }`.
- `mega-core.getUploadStorage(session)`: `Storage.fromJSON(blob)` + `reload()` for the target folder;
  cache per `sid` (replacing the email+password-keyed cache). Remove the `requireCredentialString`
  reads of `megaEmail`/`megaPassword`.
- **Asymmetry (documented):** upload necessarily needs the master key to wrap the new file key, so
  the upload worker receives the full session blob (incl. master key). This is still strictly safer
  than today's plaintext password (the password adds permanent account control + lockout; the blob
  does not). Download workers never receive the master key.

## Module boundaries

- **`mega-provider.ts`** (main thread): owns the authenticated `Storage`, session persistence
  (`toJSON`/`fromJSON`), migration, 2FA error mapping, needs-attention state, and worker-credential
  minting. Public surface unchanged except credential-bag shapes and new typed errors.
- **`mega-core.ts`** (worker): stateless download via `sid + nodeId + fileKey`; upload via
  `fromJSON(session)`. No knowledge of localStorage or the UI.
- **`CloudView.svelte`**: 2FA two-step form state + needs-attention reconnect UI. Calls the provider;
  no megajs knowledge.
- **`provider-detection.ts` / `provider-manager.ts`**: detection + logout key hygiene for the new
  `mega_session` key alongside legacy cleanup.
- **`provider-interface.ts`**: documents `secondFactorCode` + `MFA_REQUIRED`.

## Testing

- **Vitest (CI, mocked megajs).** Mock `Storage` / `Storage.fromJSON` / `File`. Cover:
  - migration: legacy `mega_email`+`mega_password` → `mega_session` written, legacy keys removed;
  - 2FA: login throws `EMFAREQUIRED` → provider rethrows `MFA_REQUIRED`; retry with code succeeds;
  - session loss: `ESID` on an op → `markSessionExpired()` clears `mega_session` + needs-attention;
  - logout clears `mega_session` + legacy keys;
  - worker credential shapes: download → `{ sid, nodeId, fileKey }` (no master key); upload →
    `{ megaSession }` (no password).
- **Manual / live (not CI; needs a real account).** non-2FA login; 2FA login; reload reuses session
  (DevTools: no `us` login request, `mega_session` present, no `mega_password`); worker download
  issues **no** `link`/`unshare` requests; worker upload `postMessage` carries **no** password;
  revoke session in MEGA settings → reconnect prompt appears.

## Build-time verification items (confirm via tests/spikes during implementation)

1. `Storage.fromJSON` + `storage.reload()` signature, and that `reload()` refreshes `storage.files`
   on a `fromJSON`'d session (drives §B restore + §C `reinitialize`).
2. **Linchpin:** Option-B owned-node download (`new File({ downloadId: nodeId, key, api })` +
   `file.nodeId = nodeId` + `api.sid`) actually downloads an owned file. Source analysis says yes;
   confirm live in Phase 2. *Fallback if it fails:* download worker uses `fromJSON(session)` +
   `reload()` and `storage.files[nodeId].downloadBuffer()` (accepts the master key in the download
   worker — still no share link).
3. Upload via `fromJSON + reload` reaches the target folder correctly (§G).
4. Browser megajs build exports `Storage.fromJSON` / `File` for worker use (research says yes;
   `mega-core` already imports both).

## Phasing

- **Phase 1 (auth + upload worker):** §A–E **and §G** — token storage, 2FA two-step UI,
  needs-attention/session-loss UX, migration, detection/logout hygiene, **and the upload-worker
  switch from password to session blob** (forced because §A removes the password the upload worker
  reads). Download workers continue using share links unchanged (the main-thread session restored via
  `fromJSON` still mints them). Self-contained and shippable. One reviewable PR.
  - Build-time verifications needed here: #1 (`fromJSON`/`reload`), #3 (upload via `fromJSON+reload`),
    #4 (browser build exports).
- **Phase 2 (download workers):** §F — replace share-link downloads with `sid + nodeId + fileKey`,
  delete the entire share-link machinery (`createShareLink`/`deleteShareLink`/mutex/throttle/
  `megaShareUrl`), unit tests + live verification. One reviewable PR.
  - Build-time verification needed here: #2 (the owned-node-download linchpin).

## Out of scope

- Encrypting the stored session blob at rest.
- Re-architecting megajs's upload key-wrapping to keep the master key out of the upload worker.
- Changes to other providers (Google Drive, WebDAV) beyond shared interface documentation.
