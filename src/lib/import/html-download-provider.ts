import { getItems } from '$lib/upload';
import { IMAGE_EXTENSIONS } from './types';
import { normalizeFilename } from '$lib/util';

export type HtmlImportType = 'directory' | 'cbz';

export interface HtmlDownloadRequest {
  source: string;
  manga: string;
  volume: string;
  type: HtmlImportType;
  cover?: string;
  cbzUrl?: string;
}

export interface HtmlDownloadResult {
  importFiles: File[];
  coverFile: File | null;
}

export interface HtmlDownloadProgress {
  status: string;
  progress: number;
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
      return {
        source: cbzUrl.origin,
        manga,
        volume,
        type: 'cbz',
        cbzUrl: cbzUrl.toString()
      };
    } catch {
      return null;
    }
  }

  const manga = params.get('manga');
  const volume = params.get('volume');
  if (!manga || !volume) return null;

  const type = (params.get('type') || 'directory').toLowerCase();
  if (type !== 'directory' && type !== 'cbz') return null;

  return {
    source: (params.get('source') || 'https://mokuro.moe/manga').replace(/\/$/, ''),
    manga,
    volume,
    type,
    cover: params.get('cover') || undefined
  };
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
  volumeBaseUrl: string,
  normalizedVolume: string
): Promise<File | null> {
  const response = await fetch(`${volumeBaseUrl}.mokuro`, { cache: 'no-store' });
  if (!response.ok) {
    // Support servers storing compressed sidecar as .mokuro.gz
    const gzResponse = await fetch(`${volumeBaseUrl}.mokuro.gz`, { cache: 'no-store' });
    if (!gzResponse.ok || typeof DecompressionStream === 'undefined') return null;
    const gzBlob = await gzResponse.blob();
    const stream = gzBlob.stream().pipeThrough(new DecompressionStream('gzip'));
    const blob = await new Response(stream).blob();
    const file = new File([blob], `${normalizedVolume}.mokuro`, {
      type: 'application/json'
    });
    setRelativePath(file, `/${normalizedVolume}.mokuro`);
    return file;
  }

  const blob = await response.blob();
  const file = new File([blob], `${normalizedVolume}.mokuro`, {
    type: blob.type || 'application/json'
  });
  setRelativePath(file, `/${normalizedVolume}.mokuro`);
  return file;
}

async function tryFetchCoverSidecar(
  request: HtmlDownloadRequest,
  normalizedVolume: string,
  volumeBaseUrl: string
): Promise<File | null> {
  const candidateUrls: string[] = [];

  if (request.cover) {
    candidateUrls.push(
      /^https?:\/\//i.test(request.cover)
        ? request.cover
        : `${request.source}/${request.cover.replace(/^\/+/, '')}`
    );
  }

  candidateUrls.push(`${volumeBaseUrl}.webp`);

  for (const coverUrl of candidateUrls) {
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
    return file;
  }

  console.log('[HTML Download] No thumbnail sidecar found for volume:', normalizedVolume);
  return null;
}

class HtmlDownloadPseudoProvider {
  readonly type = 'html-download' as const;
  readonly name = 'HTML Download';

  async download(
    request: HtmlDownloadRequest,
    onProgress?: (state: HtmlDownloadProgress) => void
  ): Promise<HtmlDownloadResult> {
    const normalizedVolume = normalizeFilename(request.volume);
    const volumeBaseUrl = request.cbzUrl
      ? request.cbzUrl.replace(/\.(cbz|zip|cbr|rar|7z)$/i, '')
      : `${request.source}/${encodeURIComponent(request.manga)}/${encodeURIComponent(request.volume)}`;
    const importFiles: File[] = [];
    let coverFile: File | null = null;

    onProgress?.({
      status: request.type === 'cbz' ? 'Fetching volume archive...' : 'Fetching source files...',
      progress: 0
    });

    if (request.type === 'cbz') {
      const cbzTarget = request.cbzUrl || `${volumeBaseUrl}.cbz`;
      const cbzRes = await fetch(cbzTarget, { cache: 'no-store' });
      if (!cbzRes.ok) {
        throw new Error(`Failed to fetch CBZ file: ${cbzRes.status}`);
      }

      const cbzBlob = await cbzRes.blob();
      const cbzFile = new File([cbzBlob], `${normalizedVolume}.cbz`, {
        type: cbzBlob.type || 'application/zip'
      });
      setRelativePath(cbzFile, `/${normalizedVolume}.cbz`);
      importFiles.push(cbzFile);

      onProgress?.({ status: 'Fetching OCR sidecar (optional)...', progress: 70 });

      const mokuroFile = await tryFetchMokuroSidecar(volumeBaseUrl, normalizedVolume);
      if (mokuroFile) {
        importFiles.push(mokuroFile);
      }

      coverFile = await tryFetchCoverSidecar(request, normalizedVolume, volumeBaseUrl);
      return { importFiles, coverFile };
    }

    const mokuroFile = await tryFetchMokuroSidecar(volumeBaseUrl, normalizedVolume);
    if (mokuroFile) {
      importFiles.push(mokuroFile);
    }
    coverFile = await tryFetchCoverSidecar(request, normalizedVolume, volumeBaseUrl);

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

      const downloadProgress = totalImages
        ? 10 + Math.floor((completed / totalImages) * 80)
        : 90;
      onProgress?.({
        status: `Downloading images (${completed}/${totalImages})...`,
        progress: downloadProgress
      });
    }

    return { importFiles, coverFile };
  }
}

export const htmlDownloadProvider = new HtmlDownloadPseudoProvider();
