/**
 * The identity of a `.mokuro` sidecar: lowercase hex SHA-256 of its JSON bytes
 * (after gunzip, for a `.mokuro.gz`). This is the `mokuro_sha256` contract
 * `series.json` carries per volume and `VolumeMetadata.mokuro_sha256` records
 * for the installed primary OCR — see CLAUDE.md, "OCR upgrades".
 *
 * Pure and dependency-free so a Worker (the backup upload, the sidecar
 * backfill's deferred feed) can hash exactly the bytes it uploads.
 */

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
 * A layer the OCR upgrade filed (`updated-ocr`) that nobody has touched since:
 * still a mirror of the cloud's own PRIMARY sidecar, so it is never uploaded
 * as a layer file (the cloud already holds those pages) and a newer upgrade
 * replaces it in place. See `VolumeOcrLayer.source_at`.
 */
export function isUntouchedUpdatedOcr(
  layer: { source_sha256?: string; source_at?: string; updated_at?: string } | undefined
): boolean {
  return !!layer?.source_sha256 && !!layer.source_at && layer.source_at === layer.updated_at;
}
