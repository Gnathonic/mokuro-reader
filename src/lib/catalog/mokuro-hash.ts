/**
 * The identity of a `.mokuro` sidecar: lowercase hex SHA-256 of its JSON bytes
 * (after gunzip, for a `.mokuro.gz`). This is the `mokuro_sha256` contract
 * `series.json` carries per volume and `VolumeMetadata.mokuro_sha256` records
 * for the installed primary OCR — see CLAUDE.md, "OCR upgrades".
 *
 * Pure (so are its imports: the layer ids of `layer-names.ts` and the
 * dependency-free `layer-kind.ts`) so a Worker (the backup upload, the sidecar backfill's deferred feed) can hash
 * exactly the bytes it uploads.
 */

import {
  isCuratedLayerId,
  isPersonalLayerId,
  isServerKeepsakeLayerId
} from '$lib/reader/edit/layer-names';
import { isCloudModelOutput } from '$lib/reader/edit/layer-kind';
import type { VolumeOcrLayer, VolumeOcrLayerKind } from '$lib/types';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** A usable `mokuro_sha256`: exactly 64 lowercase hex digits. */
export function isMokuroSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_RE.test(value);
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * SHA-256 of these bytes as lowercase hex, or `undefined` when the platform
 * cannot hash (no `crypto.subtle` — an insecure origin). Never rejects: a
 * missing hash only means "unknown", which every consumer already handles.
 */
export async function sha256Hex(
  data: Blob | ArrayBuffer | Uint8Array
): Promise<string | undefined> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return undefined;
    // Duck-typed, not `instanceof`: bytes can come from another realm (a
    // Worker message, a test environment's own globals).
    const bytes =
      typeof (data as Blob).arrayBuffer === 'function'
        ? await (data as Blob).arrayBuffer()
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
          : new Uint8Array(data as ArrayBuffer).slice();
    return toHex(await subtle.digest('SHA-256', bytes as BufferSource));
  } catch (error) {
    console.debug('[mokuro-hash] could not hash sidecar bytes:', error);
    return undefined;
  }
}

/**
 * Where a volume's `mokuro_sha256` is KNOWN to describe a cloud file — the
 * certainty `buildSeriesFile` needs before it may publish the hash.
 *
 * Recorded only when this device uploaded those exact bytes as the volume's
 * primary sidecar, or installed the primary from a download of that listed
 * file. `size` is the STORED file's byte count (the `.gz` size for a gzipped
 * sidecar), `modified` its listing mtime in epoch seconds when the server gave
 * one — the same units as `SeriesFileVolume.mokuro_size`/`mokuro_modified`,
 * so the attestation is checked against the listing's own stamps.
 */
export interface MokuroCloudAttestation {
  provider: string;
  size: number;
  modified?: number;
}

/** A usable attestation (shape-checked: rows are user data in IndexedDB). */
export function isMokuroCloudAttestation(value: unknown): value is MokuroCloudAttestation {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<MokuroCloudAttestation>;
  return (
    typeof v.provider === 'string' &&
    typeof v.size === 'number' &&
    Number.isInteger(v.size) &&
    v.size > 0 &&
    (v.modified === undefined || (Number.isInteger(v.modified) && v.modified >= 0))
  );
}

/**
 * A layer the OCR upgrade wrote (`cloud-ocr-upgrade.ts`) that nobody has
 * touched since — `source_at` still equals `updated_at`. That is the
 * `updated-ocr` layer: an EDITED volume's copy of the cloud's newer primary. A
 * mirror of the cloud's own PRIMARY sidecar, so never uploaded as a layer file
 * (the cloud already holds those pages).
 *
 * While untouched: never pushed, never exported, never embedded, and a later
 * upgrade replaces it in place. A user edit moves `updated_at`, the mark
 * dies, and the row is the user's own layer from then on. See
 * `VolumeOcrLayer.source_at`.
 */
export function isUntouchedUpgradeLayer(
  layer: { source_at?: string; updated_at?: string } | undefined
): boolean {
  return !!layer?.source_at && layer.source_at === layer.updated_at;
}

/** The OCR editor's read-only pre-edit snapshot (`edit-persist.ts`'s `ORIGINAL_LAYER_ID`). */
const ORIGINAL_LAYER = 'original';

/** Where a layer would go: what `layerStaysLocal` needs to know of the provider. */
export interface LayerTarget {
  /** The server compiles its own metadata (mokuro-bunko, `ProviderStatus`). */
  serverCompilesMetadata: boolean;
  /** `ProviderStatus.editLayerSync`: may the account's `edit` layer go up there? */
  editLayerSync?: 'push' | 'local';
  /**
   * The target's provider type (`SyncProvider.type`), when it is one: a row's
   * `cloud.server_compiled` mark counts only there (`pulledFromCompilingServer`).
   * Absent for an export or a file, which no server rewrites.
   */
  provider?: string;
}

/**
 * Was this row's cloud copy pulled from THIS target while its provider said
 * the server compiles its metadata (`cloud.server_compiled`)? Then it is still
 * that server's OCR there, though the status may read plain storage again (a
 * stale cloud-direct marker, a failed identity probe). Only on the provider it
 * came from: an export, a file or another provider is not the server that
 * would rewrite it, so the mark says nothing about them.
 */
export function pulledFromCompilingServer(
  layer: { cloud?: unknown },
  target: Pick<LayerTarget, 'provider'>
): boolean {
  const cloud = layer.cloud as { provider?: string; server_compiled?: true } | undefined;
  return (
    cloud?.server_compiled === true &&
    target.provider !== undefined &&
    cloud.provider === target.provider
  );
}

/**
 * The account a personal layer's (`edit`, `edit-<n>`) cloud copy belongs to,
 * stamped on its row (`VolumeOcrLayer.cloud.account`) and compared with it:
 * the provider's `accountScope`, but only on a WebDAV-connected bunko — the
 * one place two accounts read two files at one path, and the one whose scope
 * (server + username) is stable for an account. Only that provider reports
 * `editLayerSync` at all; `push` or `local` alike, since a 0.8 bunko whose
 * identity probe fell back reads `local` and an overlay pulled then is still
 * this account's (whether it may go UP is the push gate's call, not this).
 * Anywhere else the path IS the file, so there is nothing to tell apart, and
 * a scope need not even be stable within one account: Google Drive's is
 * `default` until its reader folder resolves, then that folder's id, and a
 * stamp from before would read as another account's from then on — so a
 * cloud-direct marker (serverCompilesMetadata, no `editLayerSync`) never
 * stamps.
 */
export function personalLayerAccount(status: {
  serverCompilesMetadata?: boolean;
  editLayerSync?: 'push' | 'local';
  accountScope?: string;
}): string | undefined {
  return status.serverCompilesMetadata === true && status.editLayerSync !== undefined
    ? status.accountScope
    : undefined;
}

/**
 * A personal layer (`edit`, `edit-<n>`) last synced under ANOTHER account of
 * this provider (`account` = the active `personalLayerAccount`) — two
 * accounts on one device and one server, each of which bunko serves its own
 * `<Volume>.edit.mokuro` at the same path. Never pushed, nor uploaded beside a
 * backup: it would overwrite this account's own overlay. A row stamped before
 * accounts were recorded has no `account` and counts as this one's.
 */
export function syncedForOtherAccount(
  row: Pick<VolumeOcrLayer, 'layer_id' | 'cloud'>,
  account: string | undefined
): boolean {
  return (
    !!account &&
    !!row.cloud?.account &&
    row.cloud.account !== account &&
    isPersonalLayerId(row.layer_id)
  );
}

/**
 * Must this layer stay OFF this provider (never pushed, never uploaded beside
 * a backup)? An untouched upgrade layer, everywhere (`isUntouchedUpgradeLayer`);
 * on a server that compiles its metadata, its own model output
 * (`isCloudModelOutput`) even when edited here — an edit forks into `edit`
 * there, but one begun before the provider said so (signing in, a
 * cloud-direct marker not read yet) edits the row in place, and must not
 * replace what the model wrote for every account; and whatever
 * `layerIdStaysLocal` says of its id.
 */
export function layerStaysLocal(
  layer: {
    layer_id: string;
    source_at?: string;
    updated_at?: string;
    kind?: VolumeOcrLayerKind;
    engine?: string;
    cloud?: unknown;
  },
  target: LayerTarget
): boolean {
  if (isUntouchedUpgradeLayer(layer)) return true;
  // Or pulled from this provider while it said so: still its OCR, though the
  // status may read plain storage again.
  const compiled = target.serverCompilesMetadata || pulledFromCompilingServer(layer, target);
  if (compiled && isCloudModelOutput(layer)) return true;
  return layerIdStaysLocal(layer.layer_id, target);
}

/**
 * The id half of `layerStaysLocal` — what a layer IS, whatever happened to it,
 * so it also says whether its cloud file is this device's to delete:
 *
 * - `curated`, everywhere: the library's shared corrections go up only by an
 *   explicit Publish, never by sync or backup.
 * - an account's own `edit`/`edit-<n>` where `editLayerSync` is `local`: a
 *   bunko that does not keep it per account would publish it to every account.
 * - on a provider that compiles its metadata (bunko): the editor's `original`
 *   snapshot — a primary edit stays local there, so the snapshot of what it
 *   sits on means nothing to the server, and on a shared library it would be
 *   published, as a reserved layer, to every user — and bunko's own
 *   keepsake, a case merge's `curated-<n>`, which only the server writes (a
 *   PUT is refused, and a delete from here would remove the one copy every
 *   account reads). Plain storage keeps `original`: there it is this user's
 *   own file.
 *
 * Any other id is a hand-made layer (`pre-upgrade…` and `previous-ocr…`
 * included: bunko neither writes nor reserves them) and goes wherever the
 * account may write library files.
 */
export function layerIdStaysLocal(layerId: string, target: LayerTarget): boolean {
  if (isCuratedLayerId(layerId)) return true;
  if (isPersonalLayerId(layerId)) return target.editLayerSync === 'local';
  if (!target.serverCompilesMetadata) return false;
  return layerId === ORIGINAL_LAYER || isServerKeepsakeLayerId(layerId);
}
