/**
 * Which volumes THIS device moved since its last `positions.json` write.
 *
 * Only the set of uuids is kept; the entry itself is always built from the
 * local record at push time, so it carries the record's own stamp. The set is
 * persisted (`positions:changed`) so a turn made just before the tab closed
 * still goes up after the reload. Storage is a convenience: when it throws,
 * the set lives in memory.
 */

import { get } from 'svelte/store';
import { registerPositionListener, volumesWithTrash } from '$lib/settings/volume-data';
import type { PositionsMap } from './positions-file';

const STORAGE_KEY = 'positions:changed';

let changed: Set<string> | null = null;

function load(): Set<string> {
  if (changed) return changed;
  changed = new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const id of parsed) if (typeof id === 'string') changed.add(id);
    }
  } catch {
    // Unreadable storage: start empty, in memory.
  }
  return changed;
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...load()]));
  } catch {
    // In memory only.
  }
}

/** Start marking volumes this device moves. Returns the unregister function. */
export function initPositionTracking(): () => void {
  load();
  return registerPositionListener((volume) => {
    load().add(volume);
    save();
  });
}

export function changedVolumes(): string[] {
  return [...load()];
}

/** Entries for the changed volumes, from the local records, under `device`. */
export function ownChangedEntries(device: string): PositionsMap {
  const records = get(volumesWithTrash);
  const out: PositionsMap = {};
  for (const volume of load()) {
    const record = records[volume];
    if (!record || record.deletedOn) continue;
    const t = Date.parse(record.lastProgressUpdate);
    if (!(t > 0)) continue;
    out[volume] = { t, page: record.progress, chars: record.chars, device };
  }
  return out;
}

/**
 * After a write: clear only the volumes whose record stamp still equals the
 * entry that went up. A turn that landed during the upload moved the stamp, so
 * that volume stays marked for the next push.
 */
export function clearChanged(built: PositionsMap): void {
  const set = load();
  const records = get(volumesWithTrash);
  for (const volume of [...set]) {
    const record = records[volume];
    const stamp = record ? Date.parse(record.lastProgressUpdate) : NaN;
    if (!record || record.deletedOn || !(stamp > 0)) {
      // Nothing left to push for it.
      set.delete(volume);
      continue;
    }
    const entry = built[volume];
    if (entry && stamp === entry.t) set.delete(volume);
  }
  save();
}

/** Tests: forget the in-memory set (and, unless kept, the stored one). */
export function _resetPositionTracking(options: { keepStorage?: boolean } = {}): void {
  changed = null;
  if (!options.keepStorage) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
