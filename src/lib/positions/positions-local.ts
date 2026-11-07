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
import { stampMs } from '$lib/util/volume-helpers';
import type { PositionsMap } from './positions-file';

const STORAGE_KEY = 'positions:changed';

/**
 * Volume → the record stamp THIS device set. A record whose stamp has since
 * moved without a notice was moved by another device's position (a
 * volume-data merge, an adoption): it is not ours to push under our name.
 */
let changed: Map<string, number> | null = null;

/** The record's stamp; 0 for a missing or deleted record. */
function stampOf(volume: string): number {
  const record = get(volumesWithTrash)[volume];
  if (!record || record.deletedOn) return 0;
  return stampMs(record.lastProgressUpdate);
}

function load(): Map<string, number> {
  if (changed) return changed;
  changed = new Map();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, t] of Object.entries(parsed)) {
        if (typeof t === 'number' && Number.isFinite(t)) changed.set(id, t);
      }
    }
  } catch {
    // Unreadable storage: start empty, in memory.
  }
  return changed;
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(load())));
  } catch {
    // In memory only.
  }
}

/** Start marking volumes this device moves. Returns the unregister function. */
export function initPositionTracking(): () => void {
  load();
  return registerPositionListener((volume) => {
    const t = stampOf(volume);
    if (!(t > 0)) return;
    load().set(volume, t);
    save();
  });
}

export function changedVolumes(): string[] {
  return [...load().keys()];
}

/** The record stamp this device marked the volume changed at; undefined when unmarked. */
export function changedMark(volume: string): number | undefined {
  return load().get(volume);
}

/** Entries for the changed volumes, from the local records, under `device`. */
export function ownChangedEntries(device: string): PositionsMap {
  const records = get(volumesWithTrash);
  const out: PositionsMap = {};
  for (const [volume, marked] of load()) {
    const record = records[volume];
    if (!record || record.deletedOn) continue;
    const t = stampMs(record.lastProgressUpdate);
    // Moved since by another device's position: not ours to label.
    if (!(t > 0) || t !== marked) continue;
    out[volume] = { t, page: record.progress, chars: record.chars, device };
  }
  return out;
}

/**
 * After a write: clear the volumes whose mark went up as built. A turn that
 * landed during the upload moved the mark, so that volume stays for the next
 * push. A volume deleted, unstamped, or moved by another device since its mark
 * has nothing of ours left to push.
 */
export function clearChanged(built: PositionsMap): void {
  const marks = load();
  for (const [volume, marked] of [...marks]) {
    const stamp = stampOf(volume);
    if (!(stamp > 0) || stamp !== marked || built[volume]?.t === marked) marks.delete(volume);
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
