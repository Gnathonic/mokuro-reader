import { getItems } from '$lib/upload';
import { IMAGE_EXTENSIONS } from './types';
import { normalizeFilename } from '$lib/util';
import {
  decrementPoolUsers,
  getFileProcessingPool,
  incrementPoolUsers
} from '$lib/util/file-processing-pool';
import { generateUUID } from '$lib/util/uuid';
import type { FetchedLayerFile } from '$lib/metadata/layer-sync';
import { fetchVolumeManifest, type VolumeManifest } from './deep-link-manifest';
import { parseImportedSeriesFile, type PendingSeriesFile } from './series-file-import';

export type HtmlImportType = 'directory' | 'cbz';

export interface HtmlDownloadRequest {
  source: string;
  manga: string;
  volume: string;
  type: HtmlImportType;
  cover?: string;
  cbzUrl?: string;
  /** The volume manifest the link carries (`manifest=`), absolute. */
  manifestUrl?: string;
}

export interface HtmlDownloadResult {
  bundleType: 'directory' | 'single' | 'pair' | 'triple';
  archiveFile: File | null;
  mokuroFile: File | null;
  importFiles: File[];
  coverFile: File | null;
  /** Engine layers the manifest listed, fetched but not yet decoded (`importFetchedLayers`). */
  layers: FetchedLayerFile[];
  /** The series' `series.json`, validated, to apply once the volume is saved. */
  seriesFile: PendingSeriesFile | null;
  /** The manifest that drove this download; null on the legacy guessing path. */
  manifest: VolumeManifest | null;
  /** Where that manifest was fetched from (the link's `manifest` param). */
  manifestUrl: string | null;
}

export interface HtmlDownloadProgress {
  status: string;
  progress: number;
}

async function fetchBlobWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number | null) => void
): Promise<{ response: Response; blob: Blob }> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }

  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : null;
  const body = response.body;
  if (!body) {
    const blob = await response.blob();
    onProgress?.(blob.size, total);
    return { response, blob };
  }

  const reader = body.getReader();
  const chunks: ArrayBuffer[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      loaded += value.byteLength;
      onProgress?.(loaded, total);
    }
  }

  const blob = new Blob(chunks, {
    type: response.headers.get('content-type') || 'application/octet-stream'
  });
  onProgress?.(blob.size, total);
  return { response, blob };
}

async function downloadCbzBundleViaWorker(
  cbzUrl: string,
  normalizedVolume: string,
  mokuroUrls: string[],
  coverUrls: string[],
  onProgress?: (state: HtmlDownloadProgress) => void
): Promise<{
  archiveFile: File;
  mokuroFile: File | null;
  coverFile: File | null;
}> {
  // Counted as a pool user for the whole download, so another user's count
  // dropping to zero (an import's pre-scan, a queue draining) cannot
  // terminate the pool under this task.
  incrementPoolUsers();
  try {
    return await runCbzBundleTask(cbzUrl, normalizedVolume, mokuroUrls, coverUrls, onProgress);
  } finally {
    decrementPoolUsers();
  }
}

async function runCbzBundleTask(
  cbzUrl: string,
  normalizedVolume: string,
  mokuroUrls: string[],
  coverUrls: string[],
  onProgress?: (state: HtmlDownloadProgress) => void
): Promise<{
  archiveFile: File;
  mokuroFile: File | null;
  coverFile: File | null;
}> {
  const pool = await getFileProcessingPool();
  const taskId = `html-download-${generateUUID()}`;

  return await new Promise((resolve, reject) => {
    pool.addTask({
      id: taskId,
      memoryRequirement: 128 * 1024 * 1024,
      provider: 'html-download:download',
      providerConcurrencyLimit: 4,
      data: {
        mode: 'download-http-bundle',
        fileId: taskId,
        fileName: `${normalizedVolume}.cbz`,
        archiveUrl: cbzUrl,
        mokuroUrls,
        coverUrls
      },
      onProgress: (data) => {
        if (!data?.total || data.total <= 0) {
          onProgress?.({ status: 'Downloading CBZ...', progress: 40 });
          return;
        }
        const pct = Math.round((data.loaded / data.total) * 100);
        onProgress?.({
          status: `Downloading CBZ... ${pct}%`,
          progress: 5 + Math.round((pct / 100) * 63)
        });
      },
      onComplete: (result, completeTask) => {
        completeTask();
        const bundle = result?.bundle;
        if (!bundle?.archive?.data) {
          reject(new Error('Worker download bundle missing archive payload'));
          return;
        }

        const archiveFile = new File([bundle.archive.data], `${normalizedVolume}.cbz`, {
          type: bundle.archive.contentType || 'application/zip'
        });
        setRelativePath(archiveFile, `/${normalizedVolume}.cbz`);

        let mokuroFile: File | null = null;
        if (bundle.mokuro?.data) {
          mokuroFile = new File([bundle.mokuro.data], `${normalizedVolume}.mokuro`, {
            type: bundle.mokuro.contentType || 'application/json'
          });
          setRelativePath(mokuroFile, `/${normalizedVolume}.mokuro`);
        }

        let coverFile: File | null = null;
        if (bundle.cover?.data) {
          const extFromPath = extensionFromPath(bundle.cover.url);
          const extFromMime = extensionFromMimeType(bundle.cover.contentType || '');
          const extension = extFromPath || extFromMime || 'webp';
          coverFile = new File([bundle.cover.data], `${normalizedVolume}.${extension}`, {
            type: bundle.cover.contentType || 'image/webp'
          });
          setRelativePath(coverFile, `/${normalizedVolume}.${extension}`);
        }

        resolve({ archiveFile, mokuroFile, coverFile });
      },
      onError: (error) => {
        reject(new Error(error?.error || 'HTML worker download failed'));
      }
    });
  });
}

function setRelativePath(file: File, relativePath: string): void {
  Object.defineProperty(file, 'webkitRelativePath', {
    value: relativePath
  });
}

function getHashQuery(hash: string): string {
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return '';
  return hash.slice(queryIndex + 1);
}

export function getUploadParamsFromLocation(search: string, hash: string): URLSearchParams {
  const params = new URLSearchParams(search);
  const hashParams = new URLSearchParams(getHashQuery(hash));

  for (const [key, value] of hashParams.entries()) {
    params.set(key, value);
  }

  return params;
}

export function parseHtmlDownloadRequest(params: URLSearchParams): HtmlDownloadRequest | null {
  const cbz = params.get('cbz');
  if (cbz) {
    try {
      const cbzUrl = new URL(cbz, window.location.href);
      const segments = cbzUrl.pathname.split('/').filter(Boolean);
      const filename = decodeURIComponent(segments[segments.length - 1] || 'volume.cbz');
      const volume = filename.replace(/\.(cbz|zip|cbr|rar|7z)$/i, '');
      const manga = decodeURIComponent(segments[segments.length - 2] || volume);
      const manifest = params.get('manifest');
      let manifestUrl: string | undefined;
      if (manifest) {
        try {
          manifestUrl = new URL(manifest, window.location.href).toString();
        } catch {
          manifestUrl = undefined; // unusable: the legacy path, as with no param
        }
      }
      const cover = params.get('cover');
      return {
        source: cbzUrl.origin,
        manga,
        volume,
        type: 'cbz',
        cbzUrl: cbzUrl.toString(),
        ...(cover ? { cover } : {}),
        ...(manifestUrl ? { manifestUrl } : {})
      };
    } catch {
      return null;
    }
  }

  const source = params.get('source');
  const manga = params.get('manga');
  const volume = params.get('volume');
  if (!source || !manga || !volume) return null;

  const type = (params.get('type') || 'directory').toLowerCase();
  if (type !== 'directory' && type !== 'cbz') return null;

  return {
    source: source.replace(/\/$/, ''),
    manga,
    volume,
    type,
    cover: params.get('cover') || undefined
  };
}

/** The `cover` param as a URL: absolute as given, else a path on the source's origin. */
function coverParamUrl(request: HtmlDownloadRequest): string | null {
  if (!request.cover) return null;
  return /^https?:\/\//i.test(request.cover)
    ? request.cover
    : `${request.source}/${request.cover.replace(/^\/+/, '')}`;
}

function extensionFromPath(pathOrUrl: string): string {
  const pathname = pathOrUrl.split('?')[0].split('#')[0];
  const ext = pathname.split('.').pop()?.toLowerCase() || '';
  return ext.replace(/[^a-z0-9]/g, '');
}

function extensionFromMimeType(contentType: string | null): string {
  if (!contentType) return '';
  const value = contentType.toLowerCase();
  if (value.includes('webp')) return 'webp';
  if (value.includes('png')) return 'png';
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
  if (value.includes('avif')) return 'avif';
  if (value.includes('gif')) return 'gif';
  return '';
}

async function tryFetchMokuroSidecar(
  volumeBaseUrls: string[],
  normalizedVolume: string,
  onStatus?: (status: string, progress: number) => void
): Promise<File | null> {
  const totalCandidates = volumeBaseUrls.length * 2; // .mokuro + .mokuro.gz
  let checked = 0;

  for (const volumeBaseUrl of volumeBaseUrls) {
    onStatus?.(
      'Checking OCR sidecar (.mokuro)...',
      72 + Math.round((checked / totalCandidates) * 10)
    );
    const response = await fetch(`${volumeBaseUrl}.mokuro`, { cache: 'no-store' });
    checked++;
    if (response.ok) {
      const blob = await response.blob();
      const file = new File([blob], `${normalizedVolume}.mokuro`, {
        type: blob.type || 'application/json'
      });
      setRelativePath(file, `/${normalizedVolume}.mokuro`);
      return file;
    }

    // Support servers storing compressed sidecar as .mokuro.gz
    onStatus?.(
      'Checking OCR sidecar (.mokuro.gz)...',
      72 + Math.round((checked / totalCandidates) * 10)
    );
    const gzResponse = await fetch(`${volumeBaseUrl}.mokuro.gz`, { cache: 'no-store' });
    checked++;
    if (!gzResponse.ok || typeof DecompressionStream === 'undefined') {
      continue;
    }
    const gzBlob = await gzResponse.blob();
    const stream = gzBlob.stream().pipeThrough(new DecompressionStream('gzip'));
    const blob = await new Response(stream).blob();
    const file = new File([blob], `${normalizedVolume}.mokuro`, {
      type: 'application/json'
    });
    setRelativePath(file, `/${normalizedVolume}.mokuro`);
    return file;
  }

  return null;
}

function getVolumeBaseUrls(request: HtmlDownloadRequest): string[] {
  if (request.cbzUrl) {
    try {
      const cbzUrl = new URL(request.cbzUrl, window.location.href);
      const basePathname = cbzUrl.pathname.replace(/\.(cbz|zip|cbr|rar|7z)$/i, '');

      // Try with auth/query token first, then plain path fallback.
      const withQuery = `${cbzUrl.origin}${basePathname}${cbzUrl.search}`;
      const withoutQuery = `${cbzUrl.origin}${basePathname}`;
      return withQuery === withoutQuery ? [withQuery] : [withQuery, withoutQuery];
    } catch {
      return [request.cbzUrl.replace(/\.(cbz|zip|cbr|rar|7z)$/i, '')];
    }
  }

  return [
    `${request.source}/${encodeURIComponent(request.manga)}/${encodeURIComponent(request.volume)}`
  ];
}

async function tryFetchCoverSidecar(
  request: HtmlDownloadRequest,
  normalizedVolume: string,
  volumeBaseUrl: string,
  onStatus?: (status: string, progress: number) => void
): Promise<File | null> {
  const candidateUrls: string[] = [];

  const coverParam = coverParamUrl(request);
  if (coverParam) candidateUrls.push(coverParam);

  candidateUrls.push(`${volumeBaseUrl}.webp`);

  for (let index = 0; index < candidateUrls.length; index++) {
    const coverUrl = candidateUrls[index];
    onStatus?.(
      `Checking cover sidecar (${index + 1}/${candidateUrls.length})...`,
      84 + Math.round((index / Math.max(candidateUrls.length, 1)) * 10)
    );
    console.log('[HTML Download] Trying thumbnail sidecar:', coverUrl);
    const response = await fetch(coverUrl, { cache: 'no-store' });
    if (!response.ok) {
      console.log('[HTML Download] Thumbnail sidecar not found:', coverUrl, response.status);
      continue;
    }

    const blob = await response.blob();
    const extFromPath = extensionFromPath(coverUrl);
    const extFromMime = extensionFromMimeType(response.headers.get('content-type') || blob.type);
    const extension = extFromPath || extFromMime || 'webp';
    const filename = `${normalizedVolume}.${extension}`;

    const file = new File([blob], filename, { type: blob.type || 'image/webp' });
    setRelativePath(file, `/${filename}`);
    console.log('[HTML Download] Using thumbnail sidecar:', filename, `(${blob.size} bytes)`);
    onStatus?.('Downloaded cover sidecar', 95);
    return file;
  }

  console.log('[HTML Download] No thumbnail sidecar found for volume:', normalizedVolume);
  return null;
}

/** GET one listed file; null — with a warning naming it — on any failure. Never throws. */
async function fetchListedFile(url: string, what: string): Promise<Response | null> {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (response.ok) return response;
    console.warn(`[HTML Download] Could not fetch ${what} ${url}: HTTP ${response.status}`);
  } catch (error) {
    console.warn(`[HTML Download] Could not fetch ${what} ${url}:`, error);
  }
  return null;
}

async function gunzip(blob: Blob): Promise<Blob> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser cannot decompress gzip');
  }
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
}

async function fetchManifestOcr(
  ocr: NonNullable<VolumeManifest['ocr']>,
  normalizedVolume: string
): Promise<File | null> {
  const response = await fetchListedFile(ocr.url, 'OCR file');
  if (!response) return null;
  try {
    let blob = await response.blob();
    if (ocr.gz) blob = await gunzip(blob);
    const file = new File([blob], `${normalizedVolume}.mokuro`, { type: 'application/json' });
    setRelativePath(file, `/${normalizedVolume}.mokuro`);
    return file;
  } catch (error) {
    console.warn(`[HTML Download] Could not read OCR file ${ocr.url}:`, error);
    return null;
  }
}

async function fetchManifestLayers(layers: VolumeManifest['layers']): Promise<FetchedLayerFile[]> {
  const fetched = await Promise.all(
    layers.map(async (layer): Promise<FetchedLayerFile | null> => {
      const response = await fetchListedFile(layer.url, `OCR layer '${layer.id}'`);
      if (!response) return null;
      try {
        return {
          layerId: layer.id,
          gz: layer.gz,
          blob: await response.blob(),
          label: layer.url,
          ...(layer.size !== undefined ? { size: layer.size } : {}),
          ...(layer.modified !== undefined ? { modifiedTime: layer.modified } : {})
        };
      } catch (error) {
        console.warn(`[HTML Download] Could not read OCR layer ${layer.url}:`, error);
        return null;
      }
    })
  );
  return fetched.filter((layer): layer is FetchedLayerFile => layer !== null);
}

async function fetchCoverFile(url: string, normalizedVolume: string): Promise<File | null> {
  const response = await fetchListedFile(url, 'cover');
  if (!response) return null;
  try {
    const blob = await response.blob();
    const extension =
      extensionFromPath(url) ||
      extensionFromMimeType(response.headers.get('content-type') || blob.type) ||
      'webp';
    const filename = `${normalizedVolume}.${extension}`;
    const file = new File([blob], filename, { type: blob.type || 'image/webp' });
    setRelativePath(file, `/${filename}`);
    return file;
  } catch (error) {
    console.warn(`[HTML Download] Could not read cover ${url}:`, error);
    return null;
  }
}

async function fetchSeriesFile(
  seriesFile: NonNullable<VolumeManifest['series_file']>
): Promise<PendingSeriesFile | null> {
  const response = await fetchListedFile(seriesFile.url, 'series.json');
  if (!response) return null;
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    console.warn(`[HTML Download] Could not read series.json ${seriesFile.url}:`, error);
    return null;
  }
  // The import module's own validation (it warns, naming the URL, on junk).
  const modified = seriesFile.modified ?? response.headers.get('last-modified') ?? '';
  return (
    parseImportedSeriesFile(
      seriesFile.url,
      text,
      seriesFile.size ?? new TextEncoder().encode(text).byteLength,
      Date.parse(modified)
    ) ?? null
  );
}

/**
 * The manifest path: the manifest names every file, so nothing is guessed. The
 * archive is the only file whose failure fails the import; every other listed
 * file that fails is one warning naming it, and the volume imports without it.
 */
async function downloadFromManifest(
  request: HtmlDownloadRequest,
  manifest: VolumeManifest,
  normalizedVolume: string,
  onProgress?: (state: HtmlDownloadProgress) => void
): Promise<HtmlDownloadResult> {
  onProgress?.({ status: 'Downloading via worker...', progress: 5 });
  const bundle = await downloadCbzBundleViaWorker(
    manifest.archive.url,
    normalizedVolume,
    [],
    [],
    onProgress
  );

  let mokuroFile: File | null = null;
  if (manifest.ocr) {
    onProgress?.({ status: 'Fetching OCR...', progress: 72 });
    mokuroFile = await fetchManifestOcr(manifest.ocr, normalizedVolume);
  } else {
    console.log('[HTML Download] The manifest lists no OCR for volume:', normalizedVolume);
  }

  let layers: FetchedLayerFile[] = [];
  if (manifest.layers.length > 0) {
    onProgress?.({ status: `Fetching OCR layers (${manifest.layers.length})...`, progress: 78 });
    layers = await fetchManifestLayers(manifest.layers);
  }

  // A `cover` param on the link wins; the manifest's cover is used only without one.
  const coverUrl = coverParamUrl(request) ?? manifest.cover?.url ?? null;
  let coverFile: File | null = null;
  if (coverUrl) {
    onProgress?.({ status: 'Fetching cover...', progress: 86 });
    coverFile = await fetchCoverFile(coverUrl, normalizedVolume);
  }

  let seriesFile: PendingSeriesFile | null = null;
  if (manifest.series_file) {
    onProgress?.({ status: 'Fetching series info...', progress: 92 });
    seriesFile = await fetchSeriesFile(manifest.series_file);
  }

  onProgress?.({ status: 'Download complete', progress: 98 });
  return {
    bundleType: mokuroFile && coverFile ? 'triple' : mokuroFile || coverFile ? 'pair' : 'single',
    archiveFile: bundle.archiveFile,
    mokuroFile,
    importFiles: mokuroFile ? [bundle.archiveFile, mokuroFile] : [bundle.archiveFile],
    coverFile,
    layers,
    seriesFile,
    manifest,
    manifestUrl: null
  };
}

class HtmlDownloadPseudoProvider {
  readonly type = 'html-download' as const;
  readonly name = 'HTML Download';

  async download(
    request: HtmlDownloadRequest,
    onProgress?: (state: HtmlDownloadProgress) => void
  ): Promise<HtmlDownloadResult> {
    const normalizedVolume = normalizeFilename(request.volume);
    const volumeBaseUrls = getVolumeBaseUrls(request);
    const volumeBaseUrl = volumeBaseUrls[0];
    const importFiles: File[] = [];
    let coverFile: File | null = null;

    onProgress?.({
      status: request.type === 'cbz' ? 'Fetching volume archive...' : 'Fetching source files...',
      progress: 0
    });

    if (request.type === 'cbz' && request.manifestUrl) {
      onProgress?.({ status: 'Fetching volume manifest...', progress: 2 });
      const manifest = await fetchVolumeManifest(request.manifestUrl);
      if (manifest) {
        return {
          ...(await downloadFromManifest(request, manifest, normalizedVolume, onProgress)),
          manifestUrl: request.manifestUrl
        };
      }
      // Unusable (already warned once): the legacy guesses below, as with no param.
    }

    if (request.type === 'cbz') {
      const cbzTarget = request.cbzUrl || `${volumeBaseUrl}.cbz`;
      const mokuroUrls = volumeBaseUrls.flatMap((base) => [`${base}.mokuro`, `${base}.mokuro.gz`]);
      const coverUrls: string[] = [];
      const coverParam = coverParamUrl(request);
      if (coverParam) coverUrls.push(coverParam);
      coverUrls.push(`${volumeBaseUrl}.webp`);

      onProgress?.({ status: 'Downloading via worker...', progress: 5 });
      const bundle = await downloadCbzBundleViaWorker(
        cbzTarget,
        normalizedVolume,
        mokuroUrls,
        coverUrls,
        onProgress
      );
      importFiles.push(bundle.archiveFile);
      if (bundle.mokuroFile) {
        importFiles.push(bundle.mokuroFile);
      } else {
        console.log('[HTML Download] No mokuro sidecar found for volume:', normalizedVolume);
      }
      coverFile = bundle.coverFile;
      onProgress?.({ status: 'Download complete', progress: 98 });
      const bundleType: HtmlDownloadResult['bundleType'] =
        bundle.mokuroFile && coverFile
          ? 'triple'
          : bundle.mokuroFile || coverFile
            ? 'pair'
            : 'single';
      return {
        bundleType,
        archiveFile: bundle.archiveFile,
        mokuroFile: bundle.mokuroFile,
        importFiles,
        coverFile,
        layers: [],
        seriesFile: null,
        manifest: null,
        manifestUrl: null
      };
    }

    const mokuroFile = await tryFetchMokuroSidecar(
      volumeBaseUrls,
      normalizedVolume,
      (status, progress) => onProgress?.({ status, progress })
    );
    if (mokuroFile) {
      importFiles.push(mokuroFile);
    }
    coverFile = await tryFetchCoverSidecar(
      request,
      normalizedVolume,
      volumeBaseUrl,
      (status, progress) => onProgress?.({ status, progress })
    );

    onProgress?.({ status: 'Fetching image list...', progress: 5 });

    const directoryRes = await fetch(`${volumeBaseUrl}/`);
    if (!directoryRes.ok) {
      throw new Error(`Failed to fetch directory: ${directoryRes.status}`);
    }

    const html = await directoryRes.text();
    const items = getItems(html);
    const imageItems = items.filter((item) => {
      const ext = (item.pathname.split('.').at(-1) || '').toLowerCase();
      return IMAGE_EXTENSIONS.has(ext);
    });

    const totalImages = imageItems.length;
    let completed = 0;

    onProgress?.({
      status: `Downloading images (0/${totalImages})...`,
      progress: 10
    });

    for (const item of imageItems) {
      const image = await fetch(volumeBaseUrl + item.pathname);
      if (!image.ok) {
        completed++;
        continue;
      }

      const blob = await image.blob();
      const normalizedPath = normalizeFilename(item.pathname);
      const imageFile = new File([blob], normalizedPath.substring(1));
      setRelativePath(imageFile, `/${normalizedVolume}${normalizedPath}`);
      importFiles.push(imageFile);
      completed++;

      const downloadProgress = totalImages ? 10 + Math.floor((completed / totalImages) * 80) : 90;
      onProgress?.({
        status: `Downloading images (${completed}/${totalImages})...`,
        progress: downloadProgress
      });
    }

    return {
      bundleType: 'directory',
      archiveFile: null,
      mokuroFile,
      importFiles,
      coverFile,
      layers: [],
      seriesFile: null,
      manifest: null,
      manifestUrl: null
    };
  }
}

export const htmlDownloadProvider = new HtmlDownloadPseudoProvider();
