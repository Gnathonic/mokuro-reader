import { browser } from '$app/environment';
import { derived, readable, writable } from 'svelte/store';
import { volumes, type VolumeData } from '../settings/volume-data';
import { volumes as catalogVolumes } from '$lib/catalog';
import type { CompletedAtMap } from './types';

function loadCompletedAtMapFromVolumes(): CompletedAtMap {
  if (!browser) return {};

  const stored = window.localStorage.getItem('volumes');
  if (!stored) return {};

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return {};

    const map: CompletedAtMap = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([volumeId, value]) => {
      if (!value || typeof value !== 'object') return;
      const candidate = (value as { completedAt?: unknown }).completedAt;
      if (typeof candidate === 'string' && candidate.length > 0) {
        map[volumeId] = candidate;
      }
    });
    return map;
  } catch {
    return {};
  }
}

function persistCompletedAtMapToVolumes(map: CompletedAtMap) {
  if (!browser) return;

  const stored = window.localStorage.getItem('volumes');
  if (!stored) return;

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return;

    const volumesPayload = parsed as Record<string, Record<string, unknown>>;
    Object.entries(volumesPayload).forEach(([volumeId, volumeData]) => {
      if (map[volumeId]) {
        volumesPayload[volumeId] = {
          ...volumeData,
          completedAt: map[volumeId]
        };
        return;
      }

      const { completedAt: _completedAt, ...rest } = volumeData;
      volumesPayload[volumeId] = rest;
    });

    window.localStorage.setItem('volumes', JSON.stringify(volumesPayload));
  } catch {
    // Ignore storage errors
  }
}

function isVolumeCompleted(volumeData: VolumeData, totalPages: number): boolean {
  return volumeData.completed || (totalPages > 0 && volumeData.progress >= totalPages);
}

function shouldPreserveCompletedAt(
  volumeData: VolumeData,
  totalPages: number,
  previousCompletedAt?: string
): boolean {
  if (!previousCompletedAt) return false;

  if (isVolumeCompleted(volumeData, totalPages)) {
    return true;
  }

  if (totalPages > 0) {
    return false;
  }

  return volumeData.progress > 1;
}

function buildCompletedAtMapFromState(
  allVolumes: Record<string, VolumeData>,
  catalog: Record<string, { page_count?: number }>,
  previousMap: CompletedAtMap
): CompletedAtMap {
  const nextMap: CompletedAtMap = {};

  Object.entries(allVolumes).forEach(([volumeId, volumeData]) => {
    const totalPages = catalog[volumeId]?.page_count ?? 0;

    if (!isVolumeCompleted(volumeData, totalPages)) {
      if (shouldPreserveCompletedAt(volumeData, totalPages, previousMap[volumeId])) {
        nextMap[volumeId] = previousMap[volumeId];
      }
      return;
    }

    nextMap[volumeId] =
      previousMap[volumeId] ?? (volumeData.lastProgressUpdate || new Date().toISOString());
  });

  return nextMap;
}

function hasCompletedAtMapChanged(previousMap: CompletedAtMap, nextMap: CompletedAtMap): boolean {
  const previousEntries = Object.entries(previousMap);
  const nextEntries = Object.entries(nextMap);

  if (previousEntries.length !== nextEntries.length) return true;

  return nextEntries.some(([volumeId, completedAt]) => previousMap[volumeId] !== completedAt);
}

export const _completedAtMap = writable<CompletedAtMap>(loadCompletedAtMapFromVolumes());
export const completedAtMap = derived(_completedAtMap, ($map) => $map);

const _completionTracking = readable(null, () => {
  const unsubscribe = derived([volumes, catalogVolumes], ([$volumes, $catalog]) => ({
    volumes: $volumes,
    catalog: $catalog
  })).subscribe(({ volumes: $volumes, catalog: $catalog }) => {
    if (!browser || !$volumes) return;

    let nextMap: CompletedAtMap | null = null;

    _completedAtMap.update((map) => {
      const updated = buildCompletedAtMapFromState(
        $volumes as Record<string, VolumeData>,
        $catalog as Record<string, { page_count?: number }>,
        map
      );

      if (!hasCompletedAtMapChanged(map, updated)) {
        return map;
      }

      nextMap = updated;
      return updated;
    });

    if (!nextMap) return;

    Promise.resolve().then(() => {
      persistCompletedAtMapToVolumes(nextMap as CompletedAtMap);
    });
  });

  return unsubscribe;
});

if (browser) {
  _completionTracking.subscribe(() => {});
}
