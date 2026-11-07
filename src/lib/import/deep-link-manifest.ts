import { LAYER_ID_RE } from '$lib/util/sync/syncable-file';
import { resolveBunkoLink } from '$lib/util/bunko-links';
import { assertNoRedirectEscape } from '$lib/util/link-safety';

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
    resolved = resolveBunkoLink(url, base);
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
  headers?: Record<string, string>,
  fetchImpl: typeof fetch = fetch
): Promise<ManifestLoad> {
  let json: unknown;
  try {
    const response = await fetchImpl(
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
  // The link named this URL; a redirect elsewhere is the server's choice, and
  // may not land on an address the confirmation never showed.
  const guardedFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    assertNoRedirectEscape(String(input), response);
    return response;
  };
  const load = await loadVolumeManifest(manifestUrl, undefined, guardedFetch);
  if ('manifest' in load) return load.manifest;
  console.warn(
    `[HTML Download] Volume manifest ${manifestUrl} is unusable; guessing sidecars from the archive URL instead:`,
    load.error
  );
  return null;
}

/** The web origin of `url`, or null for anything that is not http(s) — `data:`, `blob:` and the rest. */
function webOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Keep a LINK's manifest on the servers the link itself named.
 *
 * The import confirmation shows the hosts in the link (`cbz=`, `manifest=`),
 * and nothing else — but a manifest may list any URL (`resolveBunkoLink` takes
 * absolute ones as given), so a public https manifest could otherwise aim the
 * archive or a sidecar fetch at a loopback or LAN address, or at plain http,
 * that the user never saw a warning for. Every listed file must therefore be
 * http(s) on one of `allowedUrls`' origins (scheme, host and port all count).
 * An optional entry that is not is dropped with one warning naming it — the
 * volume imports without it, as for a listed file that fails to fetch; an
 * archive that is not fails the manifest outright (`error`), and with it the
 * import: there is nothing to fall back to that the user agreed to.
 *
 * `allowedUrls` entries that are absent or not http(s) count for nothing.
 */
export function confineManifestToOrigins(
  manifest: VolumeManifest,
  allowedUrls: readonly (string | undefined)[]
): ManifestLoad {
  const allowed = new Set(
    allowedUrls.flatMap((url) => {
      const origin = url ? webOrigin(url) : null;
      return origin ? [origin] : [];
    })
  );
  const permitted = (url: string) => {
    const origin = webOrigin(url);
    return origin !== null && allowed.has(origin);
  };
  const keep = <T extends ManifestFile>(file: T | null, what: string): T | null => {
    if (!file || permitted(file.url)) return file;
    console.warn(
      `[HTML Download] Ignoring the manifest's ${what} at ${file.url}: it is not on a server this link named`
    );
    return null;
  };

  if (!permitted(manifest.archive.url)) {
    // The origin alone: the rest of the address is the manifest's text.
    const where = webOrigin(manifest.archive.url) ?? 'an address that is not a web address';
    return {
      error: `The volume manifest sends the download to ${where}, which is not a server this link named`
    };
  }
  return {
    manifest: {
      ...manifest,
      ocr: keep(manifest.ocr, 'OCR file'),
      layers: manifest.layers.filter((layer) => keep(layer, `OCR layer '${layer.id}'`) !== null),
      cover: keep(manifest.cover, 'cover'),
      series_file: keep(manifest.series_file, 'series.json')
    }
  };
}
