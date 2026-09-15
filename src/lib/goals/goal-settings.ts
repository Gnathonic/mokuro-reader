import { browser } from '$app/environment';
import { derived, get, writable } from 'svelte/store';
import {
  isCalendarDate,
  nextGoalTimestamp,
  parseVolumeDeadlines,
  type VolumeDeadlineEntry
} from './goals-file';
import { persistToLocalStorage } from './persist';

/**
 * Per-volume reading deadlines. Keyed by volume uuid — the same key space as
 * `volume-data.json`, so a deadline synced from another device lands on the
 * same volume everywhere.
 *
 * Stored as stamped, tombstoned entries because they ride `goals.json`; the
 * public store keeps the plain `volumeId -> 'YYYY-MM-DD'` shape the UI reads.
 */

export const GOAL_SETTINGS_STORAGE_KEY = 'goalSettings';

const GOAL_SETTINGS_STORAGE_VERSION = 1;

type DeadlineEntries = Record<string, VolumeDeadlineEntry>;

/**
 * Migrate the pre-sync shape (`volumeDeadlines: Record<volumeId, 'YYYY-MM-DD'>`).
 *
 * There is no creation stamp to recover, so these get the epoch: an un-stamped
 * legacy deadline should lose to a real edit from any device, and if no device
 * ever edits it, every copy is identical and the tie-break keeps it anyway.
 */
function migrateLegacyDeadlines(raw: unknown): DeadlineEntries {
  if (!raw || typeof raw !== 'object') return {};
  const epoch = new Date(0).toISOString();
  const out: DeadlineEntries = {};

  for (const [volumeId, deadline] of Object.entries(raw as Record<string, unknown>)) {
    if (!volumeId.trim() || !isCalendarDate(deadline)) continue;
    out[volumeId] = { deadline, lastUpdated: epoch };
  }

  return out;
}

function loadDeadlines(): DeadlineEntries {
  if (!browser) return {};

  const stored = window.localStorage.getItem(GOAL_SETTINGS_STORAGE_KEY);
  if (!stored) return {};

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return {};

    const record = parsed as Record<string, unknown>;
    if (record.version !== GOAL_SETTINGS_STORAGE_VERSION) {
      return migrateLegacyDeadlines(record.volumeDeadlines);
    }

    return parseVolumeDeadlines(record.volumeDeadlines);
  } catch {
    return {};
  }
}

const _deadlines = writable<DeadlineEntries>(loadDeadlines());

persistToLocalStorage(_deadlines, GOAL_SETTINGS_STORAGE_KEY, (volumeDeadlineEntries) =>
  JSON.stringify({
    version: GOAL_SETTINGS_STORAGE_VERSION,
    volumeDeadlines: volumeDeadlineEntries
  })
);

/** Internal: includes tombstones. Sync reads this. */
export const deadlinesWithTrash = _deadlines;

/** Public: `volumeId -> 'YYYY-MM-DD'`, tombstones filtered out. */
export const volumeDeadlines = derived(_deadlines, ($entries) => {
  const map: Record<string, string> = {};
  for (const [volumeId, entry] of Object.entries($entries)) {
    if (!entry.deletedOn) map[volumeId] = entry.deadline;
  }
  return map;
});

/** Kept for the handful of call sites that read the whole settings object. */
export const goalSettings = derived(volumeDeadlines, ($volumeDeadlines) => ({
  volumeDeadlines: $volumeDeadlines
}));

export function getVolumeDeadline(volumeId: string): string | null {
  const entry = get(_deadlines)[volumeId];
  return entry && !entry.deletedOn ? entry.deadline : null;
}

export function setVolumeDeadline(volumeId: string, deadline: string) {
  if (!isCalendarDate(deadline)) return;

  _deadlines.update((entries) => ({
    ...entries,
    [volumeId]: {
      deadline,
      lastUpdated: nextGoalTimestamp(entries[volumeId]?.lastUpdated)
    }
  }));
}

export function removeVolumeDeadline(volumeId: string) {
  _deadlines.update((entries) => {
    const existing = entries[volumeId];
    if (!existing) return entries;

    const stamp = nextGoalTimestamp(existing.lastUpdated);
    return { ...entries, [volumeId]: { ...existing, lastUpdated: stamp, deletedOn: stamp } };
  });
}

/** Replace the section wholesale — the sync merge's write-back. */
export function setVolumeDeadlineEntries(entries: DeadlineEntries) {
  _deadlines.set(entries);
}

/**
 * Tombstone the deadlines of volumes the user has explicitly deleted.
 *
 * Keyed on the READING RECORD'S TOMBSTONE, not on absence from the catalog.
 * Absence is ambiguous and dangerously so: `volumesWithPlaceholders` becomes
 * defined the moment the local Dexie read resolves, which is BEFORE the cloud
 * listing populates it, so every cloud-only volume looks missing for a window
 * on every boot. Pruning on absence there would tombstone their deadlines —
 * and tombstones sync, so the deletion would propagate to every device the
 * user owns. An explicit `deletedOn` is the one unambiguous signal that the
 * volume is gone on purpose.
 *
 * This is narrower than "clean up anything unreferenced", and deliberately so:
 * a deadline is a handful of bytes, and the cost of keeping a stale one is
 * nothing next to the cost of deleting a live one.
 */
export function pruneDeadlinesForDeletedVolumes(
  readingRecords: Record<string, { deletedOn?: string }>
) {
  const entries = get(_deadlines);

  // Decided BEFORE touching the store. `update()` fires the persist subscriber
  // even when the callback returns the value unchanged — Svelte's
  // `safe_not_equal` reports every object as changed — so an unconditional
  // update here wrote the goalSettings key on every boot, for every user,
  // including everyone who has never set a deadline.
  const doomed = Object.entries(entries).filter(
    ([volumeId, entry]) => !entry.deletedOn && readingRecords[volumeId]?.deletedOn
  );
  if (doomed.length === 0) return;

  _deadlines.update((current) => {
    const next = { ...current };
    for (const [volumeId] of doomed) {
      const entry = next[volumeId];
      if (!entry || entry.deletedOn) continue;
      const stamp = nextGoalTimestamp(entry.lastUpdated);
      next[volumeId] = { ...entry, lastUpdated: stamp, deletedOn: stamp };
    }
    return next;
  });
}
