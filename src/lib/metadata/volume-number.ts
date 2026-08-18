import type { TrackingUnit } from './types';

// Titles that name a volume outright. Unambiguous, so a match here always wins
// over the chapter veto below — "Vol 3 (Ch 21-30)" is volume 3, chapters 21-30 —
// and it is these, not `#N`, that vote on the unit in `detectTrackingUnit`.
const VOLUME_MARKERS: RegExp[] = [
  /第\s*(\d+)\s*巻/, // 第01巻
  /(?:^|[\s_\-–—([])(\d+)\s*巻/, // 3巻
  /(?:^|[^a-z])(?:vol(?:ume)?\.?)\s*(\d+)/i, // Vol 1, Volume 01, vol.3
  /(?:^|[\s_\-–—([])v\.?\s*(\d+)(?!\d)/i // v07, _v02
];

// Explicit volume markers, plus `#N` — which something has to read, and a volume
// number is the better guess, but which says nothing about the unit on its own.
const EXPLICIT_VOLUME_PATTERNS: RegExp[] = [...VOLUME_MARKERS, /(?:^|\s)#\s*(\d+)/];

// Bare trailing numbers: ambiguous on their own. Tried last, and only when no
// explicit marker matched and the title doesn't also read as a chapter (see
// CHAPTER_MARKERS below).
const BARE_VOLUME_PATTERNS: RegExp[] = [
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
 * Titles that name a chapter outright. In the `volumes` unit, when no explicit
 * volume marker matched, these veto the bare-trailing-number fallback:
 * "Chapter 5" would otherwise push volume 5 to AniList for what is the
 * series' fifth chapter. Returning undefined sends the tracker to the
 * sort-position fallback instead. An explicit volume marker (checked first in
 * `extractVolumeNumber`) always wins outright, regardless of this veto — a
 * mixed title like "One Piece Vol 3 Ch 21-30" is volume 3.
 * `#N` is deliberately absent — it is ambiguous and is already read as a volume.
 */
const CHAPTER_MARKERS: RegExp[] = [
  /第\s*\d+\s*話/, // 第12話
  /(?:^|[\s_\-–—([])\d+\s*話/, // 12話
  /(?:^|[^a-z])ch(?:apter)?\.?\s*\d+/i // Chapter 105, ch.7
];

function firstMatch(title: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (!match) continue;
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/**
 * Best-effort volume/chapter number from a stored volume title. Returns
 * undefined when nothing looks like a number for the requested unit; the
 * tracker then falls back to the volume's position in sort order.
 */
export function extractVolumeNumber(volumeTitle: string, unit: TrackingUnit): number | undefined {
  const title = (volumeTitle ?? '').trim();
  if (!title) return undefined;

  if (unit === 'chapters') return firstMatch(title, CHAPTER_PATTERNS);

  const explicit = firstMatch(title, EXPLICIT_VOLUME_PATTERNS);
  if (explicit !== undefined) return explicit;
  if (CHAPTER_MARKERS.some((pattern) => pattern.test(title))) return undefined;
  return firstMatch(title, BARE_VOLUME_PATTERNS);
}

/**
 * Guess whether a series folder holds volumes or chapters, from the titles of
 * its archives.
 *
 * This is a statement about the files, not a user preference, so it is worth
 * getting right without asking: pushing chapter 1050 as volume 1050 (or the
 * reverse) is what a wrong answer costs on AniList.
 *
 * 1. Titles that name their unit outright vote: `Chapter 12` / `第12話` against
 *    `Vol 3` / `第3巻`. The majority wins. A title carrying both ("Vol 3 (Ch
 *    21-30)") votes volume, matching `extractVolumeNumber`'s own precedence.
 * 2. With no votes (or a tie), bare numbers decide against the known totals: a
 *    folder numbered past the series' volume count, but still inside its chapter
 *    count, is chapters.
 * 3. Otherwise volumes — the common case and the safer default (AniList's
 *    `progressVolumes` is the field a manga reader expects to move).
 */
export function detectTrackingUnit(
  volumeTitles: string[],
  totals?: { total_volumes?: number; total_chapters?: number }
): TrackingUnit {
  let chapterVotes = 0;
  let volumeVotes = 0;
  let largestBare = 0;

  for (const raw of volumeTitles) {
    const title = (raw ?? '').trim();
    if (!title) continue;
    if (VOLUME_MARKERS.some((pattern) => pattern.test(title))) volumeVotes++;
    else if (CHAPTER_MARKERS.some((pattern) => pattern.test(title))) chapterVotes++;
    // Whichever unit can read the title's number: the volume reader stops at 3
    // digits (so it never mistakes a year for a number), and a four-digit
    // chapter folder is exactly the case step 2 exists to catch.
    const n = extractVolumeNumber(title, 'volumes') ?? extractVolumeNumber(title, 'chapters');
    if (n !== undefined) largestBare = Math.max(largestBare, n);
  }

  if (chapterVotes > volumeVotes) return 'chapters';
  if (volumeVotes > chapterVotes) return 'volumes';

  const { total_volumes: totalVolumes, total_chapters: totalChapters } = totals ?? {};
  const overshootsVolumes =
    typeof totalVolumes === 'number' && totalVolumes > 0 && largestBare > totalVolumes;
  const fitsChapters =
    typeof totalChapters !== 'number' || totalChapters <= 0 || largestBare <= totalChapters;
  if (overshootsVolumes && fitsChapters) return 'chapters';

  return 'volumes';
}
