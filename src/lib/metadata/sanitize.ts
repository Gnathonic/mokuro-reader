import type {
  DisplayTitleLanguage,
  SeriesExternalIds,
  SeriesTitles,
  SeriesTracking
} from './types';

/**
 * Shared validation rules for untrusted series metadata. Both boundaries where
 * foreign data enters the app — the per-series `series.json` sidecar
 * (`series-file.ts`) and the `series-metadata.json` cloud file (`merge.ts`) — use
 * these so a value that is rejected in one place cannot slip through the other.
 */

export const TITLE_KEYS = ['native', 'romaji', 'english'] as const;
export const ID_KEYS = ['anilist', 'mal'] as const;
/** Every accepted `title_preference` / `preferredTitleLanguage` value. */
export const DISPLAY_TITLE_LANGUAGES = ['imported', 'native', 'romaji', 'english'] as const;

export function isDisplayTitleLanguage(value: unknown): value is DisplayTitleLanguage {
  return (
    typeof value === 'string' && (DISPLAY_TITLE_LANGUAGES as readonly string[]).includes(value)
  );
}

/** Timestamps further ahead than this are treated as clock skew / corruption. */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize an untrusted `updated_at` into a comparable ISO string.
 *
 * `updated_at` decides merges by lexicographic comparison, so a non-ISO string
 * ("Aug 16 2020" sorts above every ISO date) or a far-future value would win
 * against every honest timestamp forever — a permanent poison pill. Unparsable
 * values return `undefined` (caller drops the entry); values more than
 * `FUTURE_TOLERANCE_MS` ahead of `now` are clamped to `now`.
 */
export function normalizeUpdatedAt(value: unknown, now: number = Date.now()): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed > now + FUTURE_TOLERANCE_MS ? now : parsed).toISOString();
}

/** Keeps only known providers with positive-integer ids. */
export function sanitizeExternalIds(value: unknown): SeriesExternalIds {
  const raw = isRecord(value) ? value : {};
  const out: SeriesExternalIds = {};
  for (const k of ID_KEYS) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v;
  }
  return out;
}

/** Keeps only known languages with non-empty string titles. */
export function sanitizeTitles(value: unknown): SeriesTitles {
  const raw = isRecord(value) ? value : {};
  const out: SeriesTitles = {};
  for (const k of TITLE_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

/** Keeps only non-empty strings. */
export function sanitizeSynonyms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
}

/** Keeps a known display language, else undefined (= no per-series override). */
export function sanitizeTitlePreference(value: unknown): DisplayTitleLanguage | undefined {
  return isDisplayTitleLanguage(value) ? value : undefined;
}

/**
 * Validates a `tracking` block from an untrusted source.
 *
 * Every field the tracker reads is checked, because each one steers a write to
 * the user's AniList account: a junk `unit` would push volume numbers into the
 * chapter field, a junk `number_overrides` entry would push `NaN` as progress,
 * and a junk `last_pushed` would make `alreadySettled()` skip real pushes.
 * A non-object drops the whole block (= "no tracking configured"); bad fields
 * inside an object are dropped or defaulted individually.
 */
export function sanitizeTracking(value: unknown): SeriesTracking | undefined {
  if (!isRecord(value)) return undefined;

  const out: SeriesTracking = {
    enabled: value.enabled === true,
    unit: value.unit === 'chapters' ? 'chapters' : 'volumes'
  };

  if (isRecord(value.number_overrides)) {
    const overrides: Record<string, number> = {};
    // AniList's progress fields are GraphQL Int — a fractional value (e.g. a
    // half-read volume) would fail the mutation, so only positive integers
    // survive here.
    for (const [uuid, n] of Object.entries(value.number_overrides)) {
      if (typeof n === 'number' && Number.isInteger(n) && n > 0) overrides[uuid] = n;
    }
    if (Object.keys(overrides).length > 0) out.number_overrides = overrides;
  }

  const lastPushed = value.last_pushed;
  if (
    isRecord(lastPushed) &&
    typeof lastPushed.n === 'number' &&
    Number.isFinite(lastPushed.n) &&
    typeof lastPushed.status === 'string' &&
    typeof lastPushed.at === 'string'
  ) {
    out.last_pushed = { n: lastPushed.n, status: lastPushed.status, at: lastPushed.at };
  }

  return out;
}

/** Series spine offset is a percentage nudge on the catalog stack step. */
export const SPINE_OFFSET_LIMIT = 50;
/** Per-volume spine nudge, in px — a volume thumbnail is 250 px wide. */
export const VOLUME_OFFSET_LIMIT = 500;

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

/**
 * Clamps `spine_offset` to ±`SPINE_OFFSET_LIMIT` %, dropping non-finite values.
 *
 * The value is added to the catalog's horizontal step and multiplies out across the
 * whole stack, so a junk number does not corrupt data but does size the card (and
 * its container) far past anything usable.
 */
export function sanitizeSpineOffset(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return clamp(value, SPINE_OFFSET_LIMIT);
}

/**
 * Keeps only non-empty string keys with finite numeric px values, clamped to
 * ±`VOLUME_OFFSET_LIMIT`. An empty result is `undefined` (= "no offsets"), so the
 * field disappears instead of being stored as `{}` — same shape as `sanitizeTracking`'s
 * `number_overrides`.
 */
export function sanitizeVolumeOffsets(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [uuid, px] of Object.entries(value)) {
    if (!uuid.trim()) continue;
    if (typeof px !== 'number' || !Number.isFinite(px)) continue;
    out[uuid] = clamp(px, VOLUME_OFFSET_LIMIT);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Trimmed non-empty string, else undefined. */
export function sanitizeTag(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
