import { LAYER_ID_RE } from '$lib/util/sync/syncable-file';

/**
 * The per-volume manifest a deep link can carry (`#/upload?cbz=…&manifest=…`).
 *
 * A server that knows its files (mokuro-bunko) lists every file of one volume —
 * archive, primary OCR, engine layers, cover, the series' `series.json` — so
 * the reader stops guessing sidecar names from the `.cbz` URL. The manifest is
 * the source of truth when it fetches and validates; anything less (absent,
 * unreachable, wrong version, no archive) and the deep link behaves exactly as
 * it did before the manifest existed.
 *
 * Every URL is resolved against the manifest's own URL (`new URL(url, base)`),
 * so the server may send absolute paths, relative paths or full URLs.
 */

export const VOLUME_MANIFEST_VERSION = 1;

export interface ManifestFile {
  /** Absolute URL, resolved against the manifest URL. */
  url: string;
  size?: number;
  /** ISO timestamp as the server stamped it. */
  modified?: string;
}

/** A sidecar that may be served gzipped: `gz` is read off the URL's path. */
export interface ManifestSidecar extends ManifestFile {
  gz: boolean;
}

export interface ManifestLayer extends ManifestSidecar {
  id: string;
}

/** One OCR job the server still has to run for this volume (Addendum A). */
export interface ManifestPendingJob {
  /** `ocr` = the primary generation, `layer` = any other. */
  kind: 'ocr' | 'layer';
  /** The generation name, which is the layer id for a layer. */
  id: string;
  /** ISO UTC finishing time the queue predicts, or null when it cannot price it. */
  eta: string | null;
}

export interface VolumeManifest {
  series?: string;
  volume?: string;
  archive: ManifestFile;
  ocr: ManifestSidecar | null;
  layers: ManifestLayer[];
  cover: ManifestFile | null;
  series_file: ManifestFile | null;
  /** `[]` when nothing is pending (or the server predates the field). */
  pending: ManifestPendingJob[];
  /** Seconds until the server suggests looking again; null when nothing is pending. */
  recheck_after: number | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isGzUrl(url: string): boolean {
  try {
    return /\.gz$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** One `{url, size?, modified?}` entry, resolved; null when it has no usable URL. */
function readFile(value: unknown, base: string): ManifestFile | null {
  if (!isObject(value)) return null;
  const { url, size, modified } = value;
  if (typeof url !== 'string' || url.trim() === '') return null;
  let resolved: string;
  try {
    resolved = new URL(url, base).toString();
  } catch {
    return null;
  }
  return {
    url: resolved,
    ...(typeof size === 'number' && Number.isFinite(size) && size >= 0 ? { size } : {}),
    ...(typeof modified === 'string' && Number.isFinite(Date.parse(modified)) ? { modified } : {})
  };
}

function readSidecar(value: unknown, base: string): ManifestSidecar | null {
  const file = readFile(value, base);
  return file ? { ...file, gz: isGzUrl(file.url) } : null;
}

/** Valid layer entries, one per id — plain beats `.gz` — in first-seen order. */
function readLayers(value: unknown, base: string): ManifestLayer[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, ManifestLayer>();
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const id = entry.id;
    if (typeof id !== 'string' || !LAYER_ID_RE.test(id)) continue;
    const file = readSidecar(entry, base);
    if (!file) continue;
    const existing = byId.get(id);
    if (existing && !existing.gz) continue;
    // Map.set on an existing key keeps its original position.
    byId.set(id, { id, ...file });
  }
  return [...byId.values()];
}

/** Pending jobs with a known kind and a name; a junk eta reads as unpriced. */
function readPending(value: unknown): ManifestPendingJob[] {
  if (!Array.isArray(value)) return [];
  const out: ManifestPendingJob[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const { kind, id, eta } = entry;
    if (kind !== 'ocr' && kind !== 'layer') continue;
    if (typeof id !== 'string' || id.trim() === '') continue;
    out.push({
      kind,
      id,
      eta: typeof eta === 'string' && Number.isFinite(Date.parse(eta)) ? eta : null
    });
  }
  return out;
}

function readRecheckAfter(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Validate a parsed manifest and resolve its URLs. Null unless it is version 1
 * with an archive URL; a malformed OPTIONAL entry is dropped on its own (as
 * though the server had listed nothing there) and never sinks the manifest.
 */
export function parseVolumeManifest(json: unknown, manifestUrl: string): VolumeManifest | null {
  if (!isObject(json) || json.version !== VOLUME_MANIFEST_VERSION) return null;
  const archive = readFile(json.archive, manifestUrl);
  if (!archive) return null;
  return {
    ...(typeof json.series === 'string' ? { series: json.series } : {}),
    ...(typeof json.volume === 'string' ? { volume: json.volume } : {}),
    archive,
    ocr: readSidecar(json.ocr, manifestUrl),
    layers: readLayers(json.layers, manifestUrl),
    cover: readFile(json.cover, manifestUrl),
    series_file: readFile(json.series_file, manifestUrl),
    pending: readPending(json.pending),
    recheck_after: readRecheckAfter(json.recheck_after)
  };
}

/** A manifest, or why there is none. */
export type ManifestLoad = { manifest: VolumeManifest } | { error: string };

/**
 * Fetch (no-store, the fetch default credentials — the same as the archive's
 * own fetch — plus any `headers` given) and validate a manifest. Never throws.
 */
export async function loadVolumeManifest(
  manifestUrl: string,
  headers?: Record<string, string>
): Promise<ManifestLoad> {
  let json: unknown;
  try {
    const response = await fetch(
      manifestUrl,
      headers ? { cache: 'no-store', headers } : { cache: 'no-store' }
    );
    if (!response.ok) return { error: `HTTP ${response.status}` };
    json = await response.json();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const manifest = parseVolumeManifest(json, manifestUrl);
  return manifest ? { manifest } : { error: 'not a version 1 manifest with an archive' };
}

/**
 * The deep link's fetch: null — after exactly one `console.warn` — when the
 * manifest cannot be used, which sends the caller down the legacy guessing path.
 */
export async function fetchVolumeManifest(manifestUrl: string): Promise<VolumeManifest | null> {
  const load = await loadVolumeManifest(manifestUrl);
  if ('manifest' in load) return load.manifest;
  console.warn(
    `[HTML Download] Volume manifest ${manifestUrl} is unusable; guessing sidecars from the archive URL instead:`,
    load.error
  );
  return null;
}
