/**
 * The root `goals.json`: this user's reading goals, the archived snapshots of
 * closed goal periods, and per-volume reading deadlines.
 *
 * A ROOT CONFIG FILE, not a compiled metadata file. `series.json` and
 * `catalog.json` are best-effort because a bunko-backed server compiles them
 * itself and rejects a scoped user's PUT by design — a rejection there is a
 * configuration, not a fault. No server compiles a user's personal reading
 * goals; there is nothing to compile them from. So goals.json sits with
 * `volume-data.json` and `profiles.json`: it is the user's own state, and a
 * silently dropped write is data loss they never learn about.
 *
 * PURE MODULE — no stores, no `$app/environment`, no Dexie. The sync layer
 * imports from here rather than from `$lib/goals`, whose barrel drags IndexedDB
 * into every sync test.
 */

import { FUTURE_TOLERANCE_MS, isRecord, normalizeUpdatedAt } from '$lib/metadata/sanitize';

export const GOALS_FILE_NAME = 'goals.json';

export const GOALS_FILE_VERSION = 1;

/** Tombstones older than this are dropped, matching the profile half. */
export const GOALS_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const EPOCH = new Date(0).toISOString();

export type GoalTypeKey = 'year' | 'season' | 'month' | 'today';

/** Snapshots also cover custom goals, which have no period key of their own. */
export type SnapshotGoalType = GoalTypeKey | 'custom';

/** Every synced goals entry carries its own merge stamp and its own tombstone. */
export interface SyncedEntry {
  /** ISO merge key — newest wins per key, exactly like `lastProgressUpdate`. */
  lastUpdated: string;
  /** ISO tombstone. Present = deleted. Purged after 30 days. */
  deletedOn?: string;
}

/** Key: `${goalType}:${periodKey}` — e.g. `year:2026`, `month:2026-08`. */
export interface GoalTargetEntry extends SyncedEntry {
  goalType: GoalTypeKey;
  periodKey: string;
  targetVolumes: number;
  createdAt: string;
}

/** Key: the goal's uuid, stable across devices. */
export interface CustomGoalEntry extends SyncedEntry {
  id: string;
  name: string;
  targetVolumes: number;
  /** `YYYY-MM-DD` local dates. */
  startDate: string;
  endDate: string;
  enabled: boolean;
  createdAt: string;
}

/**
 * Key: `${goalType}:${periodKey}`.
 *
 * No `deletedOn`: nothing deletes a snapshot, and an archived period must not
 * be erasable by a device that merely never saw it.
 */
export interface GoalSnapshotEntry {
  goalType: SnapshotGoalType;
  periodKey: string;
  startDate: string;
  endDate: string;
  /** When the period was first closed; on merge the EARLIER of the two wins. */
  closedAt: string;
  /** volume uuid -> ISO completedAt. UNIONED on merge, never replaced. */
  completed: Record<string, string>;
  /** volume uuid -> fractional volumes. Merged per volume with `Math.max`. */
  partialProgress: Record<string, number>;
  lastUpdated: string;
}

/** Key: volume uuid — the same key space as `volume-data.json`. */
export interface VolumeDeadlineEntry extends SyncedEntry {
  /** `YYYY-MM-DD` local date the volume should be finished by. */
  deadline: string;
}

export interface GoalsFileSections {
  targets: Record<string, GoalTargetEntry>;
  customGoals: Record<string, CustomGoalEntry>;
  snapshots: Record<string, GoalSnapshotEntry>;
  volumeDeadlines: Record<string, VolumeDeadlineEntry>;
}

export interface GoalsFile {
  version: number;
  updated_at: string;
  targets?: Record<string, GoalTargetEntry>;
  customGoals?: Record<string, CustomGoalEntry>;
  snapshots?: Record<string, GoalSnapshotEntry>;
  volumeDeadlines?: Record<string, VolumeDeadlineEntry>;
}

export type GoalsSectionName = keyof GoalsFileSections;

export const GOALS_SECTION_NAMES: GoalsSectionName[] = [
  'targets',
  'customGoals',
  'snapshots',
  'volumeDeadlines'
];

export function emptySections(): GoalsFileSections {
  return { targets: {}, customGoals: {}, snapshots: {}, volumeDeadlines: {} };
}

export function buildGoalKey(goalType: string, periodKey: string): string {
  return `${goalType}:${periodKey}`;
}

// ---------------------------------------------------------------------------
// Parsing. Every input here is untrusted: a cloud file another device wrote, or
// this device's own localStorage after a hand edit.
// ---------------------------------------------------------------------------

const GOAL_TYPE_KEYS: readonly string[] = ['year', 'season', 'month', 'today'];
const SNAPSHOT_GOAL_TYPES: readonly string[] = [...GOAL_TYPE_KEYS, 'custom'];

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** `YYYY-MM-DD`, and a real calendar date — not `2026-02-31`. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function stamps(value: Record<string, unknown>, now: number): SyncedEntry {
  const entry: SyncedEntry = {
    lastUpdated: normalizeUpdatedAt(value.lastUpdated, now) ?? EPOCH
  };
  const deletedOn = normalizeUpdatedAt(value.deletedOn, now);
  if (deletedOn) entry.deletedOn = deletedOn;
  return entry;
}

export function parseTargets(raw: unknown, now = Date.now()): Record<string, GoalTargetEntry> {
  if (!isRecord(raw)) return {};
  const out: Record<string, GoalTargetEntry> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim() || !isRecord(value)) continue;
    if (typeof value.goalType !== 'string' || !GOAL_TYPE_KEYS.includes(value.goalType)) continue;
    if (typeof value.periodKey !== 'string' || !value.periodKey.trim()) continue;
    // A junk target would render every progressPercent as `NaN%`.
    if (!isPositiveInteger(value.targetVolumes)) continue;

    out[key] = {
      goalType: value.goalType as GoalTypeKey,
      periodKey: value.periodKey,
      targetVolumes: value.targetVolumes,
      createdAt: normalizeUpdatedAt(value.createdAt, now) ?? EPOCH,
      ...stamps(value, now)
    };
  }

  return out;
}

export function parseCustomGoals(raw: unknown, now = Date.now()): Record<string, CustomGoalEntry> {
  if (!isRecord(raw)) return {};
  const out: Record<string, CustomGoalEntry> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim() || !isRecord(value)) continue;
    if (typeof value.id !== 'string' || !value.id.trim()) continue;
    if (!isPositiveInteger(value.targetVolumes)) continue;
    if (!isCalendarDate(value.startDate) || !isCalendarDate(value.endDate)) continue;
    if (value.startDate > value.endDate) continue;

    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!name) continue;

    out[key] = {
      id: value.id,
      name,
      targetVolumes: value.targetVolumes,
      startDate: value.startDate,
      endDate: value.endDate,
      enabled: value.enabled !== false,
      createdAt: normalizeUpdatedAt(value.createdAt, now) ?? EPOCH,
      ...stamps(value, now)
    };
  }

  return out;
}

export function parseSnapshots(raw: unknown, now = Date.now()): Record<string, GoalSnapshotEntry> {
  if (!isRecord(raw)) return {};
  const out: Record<string, GoalSnapshotEntry> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim() || !isRecord(value)) continue;
    if (typeof value.goalType !== 'string' || !SNAPSHOT_GOAL_TYPES.includes(value.goalType)) {
      continue;
    }
    if (typeof value.periodKey !== 'string' || !value.periodKey.trim()) continue;
    if (typeof value.startDate !== 'string' || typeof value.endDate !== 'string') continue;

    const completed: Record<string, string> = {};
    if (isRecord(value.completed)) {
      for (const [volumeId, stamp] of Object.entries(value.completed)) {
        if (volumeId.trim() && typeof stamp === 'string' && !Number.isNaN(Date.parse(stamp))) {
          completed[volumeId] = stamp;
        }
      }
    }

    const partialProgress: Record<string, number> = {};
    if (isRecord(value.partialProgress)) {
      for (const [volumeId, fraction] of Object.entries(value.partialProgress)) {
        if (
          volumeId.trim() &&
          typeof fraction === 'number' &&
          Number.isFinite(fraction) &&
          fraction > 0
        ) {
          partialProgress[volumeId] = fraction;
        }
      }
    }

    const closedAt = normalizeUpdatedAt(value.closedAt, now) ?? EPOCH;
    out[key] = {
      goalType: value.goalType as SnapshotGoalType,
      periodKey: value.periodKey,
      startDate: value.startDate,
      endDate: value.endDate,
      closedAt,
      completed,
      partialProgress,
      lastUpdated: normalizeUpdatedAt(value.lastUpdated, now) ?? closedAt
    };
  }

  return out;
}

export function parseVolumeDeadlines(
  raw: unknown,
  now = Date.now()
): Record<string, VolumeDeadlineEntry> {
  if (!isRecord(raw)) return {};
  const out: Record<string, VolumeDeadlineEntry> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim() || !isRecord(value)) continue;
    if (!isCalendarDate(value.deadline)) continue;
    out[key] = { deadline: value.deadline, ...stamps(value, now) };
  }

  return out;
}

export function parseGoalsFile(raw: unknown, now = Date.now()): GoalsFileSections {
  if (!isRecord(raw)) return emptySections();
  return {
    targets: parseTargets(raw.targets, now),
    customGoals: parseCustomGoals(raw.customGoals, now),
    snapshots: parseSnapshots(raw.snapshots, now),
    volumeDeadlines: parseVolumeDeadlines(raw.volumeDeadlines, now)
  };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Keys whose RAW cloud stamp is far enough in the future to be a broken clock.
 *
 * Detected BEFORE the parse-time clamp, because the clamp hides the poison: it
 * rewrites the stamp to this device's `now`, which then ties-or-beats any
 * honest pending local edit by construction. Same rule as
 * `detectBogusSeriesKeys`; checks `deletedOn` too, so a bogus tombstone cannot
 * delete a live local entry.
 */
export function detectBogusGoalKeys(raw: unknown, now: number = Date.now()): Set<string> {
  const bogus = new Set<string>();
  if (!isRecord(raw)) return bogus;

  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim() || !isRecord(value)) continue;
    for (const field of ['lastUpdated', 'deletedOn']) {
      const stamp = (value as Record<string, unknown>)[field];
      if (typeof stamp !== 'string') continue;
      const parsed = Date.parse(stamp);
      if (!Number.isNaN(parsed) && parsed > now + FUTURE_TOLERANCE_MS) bogus.add(key);
    }
  }

  return bogus;
}

function mostRecentAction(entry: SyncedEntry): number {
  return Math.max(Date.parse(entry.lastUpdated) || 0, Date.parse(entry.deletedOn ?? '') || 0);
}

/**
 * Newest action wins per key; a tie keeps local unless local is a tombstone and
 * the cloud entry is live — the same "prefer the live record on a tie" rule the
 * volume and profile merges use.
 *
 * FORFEIT-ON-BOGUS: a key in `bogusKeys` never out-ranks an existing local
 * entry. It is only adopted when local has no entry at all, where there is no
 * honest edit to protect.
 */
export function mergeGoalSection<T extends SyncedEntry>(
  local: Record<string, T>,
  cloud: Record<string, T>,
  bogusKeys: ReadonlySet<string> = new Set()
): Record<string, T> {
  const merged: Record<string, T> = { ...local };

  for (const [key, cloudEntry] of Object.entries(cloud)) {
    const localEntry = merged[key];
    if (!localEntry) {
      merged[key] = cloudEntry;
      continue;
    }
    if (bogusKeys.has(key)) continue;

    const localMost = mostRecentAction(localEntry);
    const cloudMost = mostRecentAction(cloudEntry);

    if (cloudMost > localMost) {
      merged[key] = cloudEntry;
    } else if (cloudMost === localMost && localEntry.deletedOn && !cloudEntry.deletedOn) {
      merged[key] = cloudEntry;
    }
  }

  return merged;
}

/**
 * Snapshots merge by UNION, not newest-wins.
 *
 * A snapshot is an archival aggregate and `finalizeGoalSnapshot` is
 * first-writer-wins locally, so a device that has not yet merged the other's
 * progress can close a period with a strictly poorer snapshot and lock it in
 * permanently. Concretely: 20 volumes read on the phone in December; on Jan 2
 * the laptop — last synced in November, so it knows 8 — finalizes `year:2026`
 * with 8 and uploads it. Under newest-wins the phone's honest 20 loses forever.
 *
 * Union makes convergence order-independent, which newest-wins is not.
 */
export function mergeSnapshotEntries(
  local: GoalSnapshotEntry,
  cloud: GoalSnapshotEntry
): GoalSnapshotEntry {
  const completed: Record<string, string> = { ...cloud.completed };
  for (const [volumeId, stamp] of Object.entries(local.completed)) {
    const existing = completed[volumeId];
    // A completion is a fact; on a collision keep the earlier claim.
    completed[volumeId] = existing && existing < stamp ? existing : stamp;
  }

  const partialProgress: Record<string, number> = { ...cloud.partialProgress };
  for (const [volumeId, fraction] of Object.entries(local.partialProgress)) {
    partialProgress[volumeId] = Math.max(partialProgress[volumeId] ?? 0, fraction);
  }

  const closedAt = local.closedAt < cloud.closedAt ? local.closedAt : cloud.closedAt;
  const lastUpdated = local.lastUpdated > cloud.lastUpdated ? local.lastUpdated : cloud.lastUpdated;

  return { ...local, closedAt, completed, partialProgress, lastUpdated };
}

export function mergeSnapshotSections(
  local: Record<string, GoalSnapshotEntry>,
  cloud: Record<string, GoalSnapshotEntry>
): Record<string, GoalSnapshotEntry> {
  const merged: Record<string, GoalSnapshotEntry> = { ...local };

  for (const [key, cloudEntry] of Object.entries(cloud)) {
    const localEntry = merged[key];
    merged[key] = localEntry ? mergeSnapshotEntries(localEntry, cloudEntry) : cloudEntry;
  }

  return merged;
}

export function mergeGoalsSections(
  local: GoalsFileSections,
  cloud: GoalsFileSections,
  bogusKeys: Partial<Record<GoalsSectionName, ReadonlySet<string>>> = {}
): GoalsFileSections {
  return {
    targets: mergeGoalSection(local.targets, cloud.targets, bogusKeys.targets),
    customGoals: mergeGoalSection(local.customGoals, cloud.customGoals, bogusKeys.customGoals),
    snapshots: mergeSnapshotSections(local.snapshots, cloud.snapshots),
    volumeDeadlines: mergeGoalSection(
      local.volumeDeadlines,
      cloud.volumeDeadlines,
      bogusKeys.volumeDeadlines
    )
  };
}

/** Drop tombstones that have outlived their usefulness. Snapshots have none. */
export function purgeGoalTombstones(
  sections: GoalsFileSections,
  now: number = Date.now()
): GoalsFileSections {
  const cutoff = now - GOALS_TOMBSTONE_TTL_MS;

  const purge = <T extends SyncedEntry>(section: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(section).filter(
        ([, entry]) => !entry.deletedOn || (Date.parse(entry.deletedOn) || 0) >= cutoff
      )
    );

  return {
    targets: purge(sections.targets),
    customGoals: purge(sections.customGoals),
    snapshots: sections.snapshots,
    volumeDeadlines: purge(sections.volumeDeadlines)
  };
}

/**
 * The bytes of `goals.json`. Empty sections are omitted entirely, so a library
 * that has never used goals produces byte-identical files on every device — no
 * spurious upload, no mtime churn.
 */
export function composeGoalsFile(sections: GoalsFileSections, updatedAt: string): GoalsFile {
  const file: GoalsFile = { version: GOALS_FILE_VERSION, updated_at: updatedAt };
  for (const name of GOALS_SECTION_NAMES) {
    const section = sections[name];
    if (Object.keys(section).length > 0) {
      (file as unknown as Record<string, unknown>)[name] = section;
    }
  }
  return file;
}

export function sectionsAreEmpty(sections: GoalsFileSections): boolean {
  return GOALS_SECTION_NAMES.every((name) => Object.keys(sections[name]).length === 0);
}

/**
 * A local edit must supersede what is stored even when the stored stamp is in
 * the future (another device's skewed clock, a hand-edited file): a plain `now`
 * would lose every merge until real time caught up.
 */
export function nextGoalTimestamp(existing: string | undefined, now: number = Date.now()): string {
  const previous = existing ? Date.parse(existing) : NaN;
  return new Date(Number.isNaN(previous) ? now : Math.max(now, previous + 1)).toISOString();
}
