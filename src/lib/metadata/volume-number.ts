import type { TrackingUnit } from './types';

// Ordered: explicit markers first, bare trailing numbers last.
const VOLUME_PATTERNS: RegExp[] = [
  /第\s*(\d+)\s*巻/, // 第01巻
  /(?:^|[\s_\-–—([])(\d+)\s*巻/, // 3巻
  /(?:^|[^a-z])(?:vol(?:ume)?\.?)\s*(\d+)/i, // Vol 1, Volume 01, vol.3
  /(?:^|[\s_\-–—([])v\.?\s*(\d+)(?!\d)/i, // v07, _v02
  /(?:^|\s)#\s*(\d+)/, // #4
  /(?:^|[\s_\-–—])(\d{1,3})\s*$/, // "One Piece 12", "series_04" (1–3 digits: not years)
  /^(\d+)$/ // "01"
];

const CHAPTER_PATTERNS: RegExp[] = [
  /第\s*(\d+)\s*話/, // 第12話
  /(?:^|[\s_\-–—([])(\d+)\s*話/, // 12話
  /(?:^|[^a-z])(?:ch(?:apter)?\.?)\s*(\d+)/i, // Chapter 105, ch.7
  /(?:^|\s)#\s*(\d+)/, // #12
  /(?:^|[\s_\-–—])(\d{1,4})\s*$/, // "One Piece 1050"
  /^(\d+)$/ // "012"
];

/**
 * Titles that name a chapter outright. In the `volumes` unit these must NOT
 * fall through to the bare-trailing-number pattern: "Chapter 5" would push
 * volume 5 to AniList for what is the series' fifth chapter. Returning
 * undefined sends the tracker to the sort-position fallback instead.
 * `#N` is deliberately absent — it is ambiguous and is already read as a volume.
 */
const CHAPTER_MARKERS: RegExp[] = [
  /第\s*\d+\s*話/, // 第12話
  /(?:^|[\s_\-–—([])\d+\s*話/, // 12話
  /(?:^|[^a-z])ch(?:apter)?\.?\s*\d+/i // Chapter 105, ch.7
];

/**
 * Best-effort volume/chapter number from a stored volume title. Returns
 * undefined when nothing looks like a number for the requested unit; the
 * tracker then falls back to the volume's position in sort order.
 */
export function extractVolumeNumber(volumeTitle: string, unit: TrackingUnit): number | undefined {
  const title = (volumeTitle ?? '').trim();
  if (!title) return undefined;
  if (unit === 'volumes' && CHAPTER_MARKERS.some((pattern) => pattern.test(title))) {
    return undefined;
  }
  const patterns = unit === 'chapters' ? CHAPTER_PATTERNS : VOLUME_PATTERNS;
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (!match) continue;
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}
