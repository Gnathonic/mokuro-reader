import { browser } from '$app/environment';
import { derived, get, writable } from 'svelte/store';
import {
  isCalendarDate,
  nextGoalTimestamp,
  parseVolumeDeadlines,
  type VolumeDeadlineEntry
} from './goals-file';

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

_deadlines.subscribe((volumeDeadlineEntries) => {
  if (browser) {
    window.localStorage.setItem(
      GOAL_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: GOAL_SETTINGS_STORAGE_VERSION,
        volumeDeadlines: volumeDeadlineEntries
      })
    );
  }
});

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
 * Tombstone deadlines whose volume no longer exists anywhere.
 *
 * Without this the map grows forever — and now that it syncs, it would grow
 * forever in every device's `goals.json` too. Tombstoned rather than dropped so
 * the removal propagates instead of being undone by the next sync.
 */
export function pruneDeadlinesForMissingVolumes(knownVolumeIds: ReadonlySet<string>) {
  if (knownVolumeIds.size === 0) return; // nothing loaded yet — never prune blind

  _deadlines.update((entries) => {
    let changed = false;
    const next = { ...entries };

    for (const [volumeId, entry] of Object.entries(entries)) {
      if (entry.deletedOn || knownVolumeIds.has(volumeId)) continue;
      const stamp = nextGoalTimestamp(entry.lastUpdated);
      next[volumeId] = { ...entry, lastUpdated: stamp, deletedOn: stamp };
      changed = true;
    }

    return changed ? next : entries;
  });
}
