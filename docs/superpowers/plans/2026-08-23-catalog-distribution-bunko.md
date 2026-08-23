# Catalog Distribution — Bunko Updates Plan

> Executed in the **mokuro-bunko** repository (server on unraid 192.168.2.49), not in mokuro-reader. This document is the contract the reader client is built against, plus bunko's task list. Spec: `docs/superpowers/specs/2026-08-23-catalog-distribution-design.md` (mokuro-reader repo).

**Goal:** Bunko compiles `series.json` + `catalog.json` server-side, blocks permission-scoped users' raw writes, and accepts metadata updates by intercepting `series.json` PUTs.

## Contract (binding for both sides)

1. **File partitioning.** `<Series>/series.json`, root `catalog.json`, root `series-metadata.json` are METADATA files. Root progress tracking continues to treat only OTHER root `*.json` files as user progress. A nested `<Series>/*.json` is never a progress file.
2. **Compiled `series.json`** — v2, compact JSON, exactly the reader's shape: `{version:2, series_title, external_ids, titles, synonyms, tag?, unit?, updated_at, volumes:[{volume_uuid, volume_title, page_count, character_count, mokuro_version, spine_width?}]}`. `updated_at` = facts stamp (fact edits only); `1970-01-01T00:00:00.000Z` when bunko holds no facts for the series. Volume entries come from the `.mokuro` files (uuid/title/pages/chars/version; `spine_width` when known). No per-page arrays. Readers ignore unknown keys; bunko must too.
3. **Compiled `catalog.json`** — root, compact: `{version:1, updated_at, series:[{series_title, titles, synonyms, tag?, unit?, external_ids?, updated_at}]}` — one entry per series folder, facts subset identical to that series' `series.json`, factless series included with just `series_title` + epoch stamp. Name/mapping/search data only.
4. **Serving.** Both files served with accurate `size`/`mtime` (clients version their caches on those). Regenerate on library change (archive add/remove/rename) and on every accepted update.
5. **Write blocking (scoped users).** Archives, covers, `catalog.json`: rejected. The rejection must be an ordinary error the client can ignore — clients treat metadata-write failure as best-effort and stay read-write for everything else.
6. **Intercepted `series.json` PUT.** A scoped user's PUT is an update REQUEST, not a file write:
   - Parse; validate ONLY the facts fields (`external_ids` ints, `titles`/`synonyms` strings, `tag` string, `unit` ∈ {volumes, chapters}, `updated_at` ISO). The `volumes` array and unknown keys are IGNORED (the client's index is unauthoritative; bunko's own compilation wins).
   - Merge newest-facts-stamp-wins against bunko's stored facts for that series, within the user's permission scope. A factless PUT with epoch stamp never clears facts (mirror of the reader's factless rules); a factless PUT with a strictly newer stamp is an explicit unlink.
   - On accept: persist facts, regenerate that `series.json` + `catalog.json`, respond success. On validation failure: reject; the client will silently retry later — idempotency required.
7. **Compilation advertisement.** The identity endpoint (already consumed by the reader's `webdav/identity.ts`) is the signal that this server compiles metadata: any in-contract answer (`authenticated` or `anonymous`) makes the client set `serverCompilesMetadata` and disable its own `series.json`/`catalog.json` production. Generic WebDAV servers (no identity endpoint) keep client-side production.
8. **Covers.** Per-volume cover sidecar (`<Series>/<Volume>.webp`) generated from the archive's first page when missing; scoped users cannot overwrite them.

## Tasks (bunko repo)

- [ ] 1. Partition metadata files out of progress handling (contract §1) — the previously-owed patch; regression-test that nested `series.json` never appears as a progress profile.
- [ ] 2. Series compiler: walk a series folder's `.mokuro` files → `series.json` per §2; unit tests against a fixture library incl. image-only volumes (`mokuro_version: ""`), missing spine widths, factless series.
- [ ] 3. Catalog compiler: fold all series' facts → `catalog.json` per §3; stable ordering (natural sort by folder title) so mtime/size only change on real change.
- [ ] 4. Facts store + merge: persist per-series facts with stamps; newest-wins merge incl. factless/epoch rules (§6); scope enforcement.
- [ ] 5. PUT interception on `<Series>/series.json` for scoped users → validate/merge/regenerate/respond (§6); full-permission users keep raw writes (their PUT is also safe to intercept identically — decide in-repo, contract allows either).
- [ ] 6. Write blocking per §5 for archives/covers/catalog.json.
- [ ] 7. Regeneration triggers: library scan diff + accepted updates; debounce burst updates.
- [ ] 8. Cover sidecar generation (§7).
- [ ] 9. Deploy note: compose/template on unraid diverge from repo (see project memory `project_mokuro_bunko_deploy`) — rebuild per the recorded recipe; bump version; verify with a scoped user + the reader client against the live server.

## Out of scope

Progress-file handling changes beyond partitioning; auth/permission system changes (uses existing scopes); any reader-client work (see `2026-08-23-catalog-distribution-client.md`).
