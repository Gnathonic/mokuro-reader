import type {
  DisplayTitleLanguage,
  SeriesExternalIds,
  SeriesTitles,
  SeriesTracking,
  TrackingUnit
} from './types';

/**
 * Shared validation rules for untrusted series metadata. Every boundary where
 * foreign data enters the app — the per-series `series.json` sidecar
 * (`series-file.ts`), the root `catalog.json` (`catalog-file.ts`) and the
 * `series` section of `volume-data.json` (`$lib/settings/series-data`) — uses
 * these, so a value rejected in one place cannot slip through another.
 */

export const TITLE_KEYS = ['native', 'romaji', 'english'] as const;
export const ID_KEYS = ['anilist', 'mal'] as const;
/** Every accepted `preferredTitleLanguage` value. */
// Each language option is a PROGRESSION (see display-title.ts), so 'romaji' is
// no longer a primary choice — it is the second step of both progressions. A
// stored 'romaji' preference fails this guard and migrates to the default.
export const DISPLAY_TITLE_LANGUAGES = ['imported', 'native', 'english'] as const;

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

/**
 * Validates a `tracking` block from an untrusted source.
 *
 * Every field the tracker reads is checked, because each one steers a write to
 * the user's AniList account: a junk `number_overrides` entry would push `NaN`
 * as progress, and a junk `last_pushed` would make `alreadySettled()` skip real
 * pushes. Legacy `enabled`/`unit` are dropped — pushing is a global setting and
 * the unit is a top-level fact (`sanitizeTrackingUnit`); a caller holding a
 * whole record lifts a legacy `tracking.unit` up before calling this. A
 * non-object, or an object with nothing usable left, is `undefined` (= "no
 * tracking state for this series").
 */
export function sanitizeTracking(value: unknown): SeriesTracking | undefined {
  if (!isRecord(value)) return undefined;

  const out: SeriesTracking = {};

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

  return out.number_overrides || out.last_pushed ? out : undefined;
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
 * One volume's spine nudge, in px: any finite number, clamped to
 * ±`VOLUME_OFFSET_LIMIT`.
 *
 * `0` is a REAL value here, not a gap — it is how a device that reset its shelf
 * overrides an alignment another device published (`buildSeriesFile` then omits
 * the field entirely, so a zero never reaches the file itself).
 */
export function sanitizeVolumeOffset(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return clamp(value, VOLUME_OFFSET_LIMIT);
}

/**
 * The tracking unit is a shared *fact* (it travels in `series.json`), so it is
 * validated like one: exactly one of the two known strings, else undefined —
 * "nobody has corrected it", which sends the reader to auto-detection.
 */
export function sanitizeTrackingUnit(value: unknown): TrackingUnit | undefined {
  return value === 'volumes' || value === 'chapters' ? value : undefined;
}

/** Trimmed non-empty string, else undefined. */
export function sanitizeTag(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
