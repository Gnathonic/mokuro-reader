/**
 * Reading-speed results and the time estimates built on them. The speed
 * itself is computed from reading history (`reading-history/stats-store.ts`,
 * `recentReadingSpeed` and `seriesSpeed`).
 */

export interface ReadingSpeedResult {
  charsPerMinute: number;
  isPersonalized: boolean;
  confidence: 'high' | 'medium' | 'low' | 'none';
  sessionsUsed: number;
}

/**
 * Calculate time to finish for a volume based on its total character count and progress
 * Pure function that can be used for any volume, not tied to current volume
 */
export function calculateVolumeTimeToFinish(
  totalChars: number,
  charsRead: number,
  readingSpeed: ReadingSpeedResult
): {
  minutes: number;
  hours: number;
  displayText: string;
} | null {
  if (totalChars === 0) {
    return null;
  }

  const remainingChars = totalChars - charsRead;

  if (remainingChars <= 0) {
    return null;
  }

  const minutes = Math.ceil(remainingChars / readingSpeed.charsPerMinute);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  let displayText: string;
  if (minutes < 60) {
    displayText = `~${minutes} min left`;
  } else {
    displayText = `~${hours}h ${mins}m left`;
  }

  return { minutes, hours, displayText };
}

/**
 * NOTE: Convenience functions using require() don't work in browser contexts.
 * Components should import stores directly and pass values to pure functions like
 * calculateVolumeTimeToFinish() instead.
 *
 * Example usage:
 *
 * import { volumes } from '$lib/settings';
 * import { personalizedReadingSpeed } from '$lib/settings/reading-speed';
 * import { currentVolumeCharacterCount } from '$lib/catalog';
 * import { calculateVolumeTimeToFinish } from '$lib/util/reading-speed';
 *
 * let timeEstimate = $derived.by(() => {
 *   const volumeProgress = $volumes[volumeId];
 *   const charsRead = volumeProgress?.chars || 0;
 *   return calculateVolumeTimeToFinish($currentVolumeCharacterCount, charsRead, $personalizedReadingSpeed);
 * });
 */

/**
 * Calculate estimated reading time for a total character count
 */
export function calculateEstimatedTime(
  totalChars: number,
  readingSpeed: ReadingSpeedResult
): {
  minutes: number;
  hours: number;
  displayText: string;
  isPersonalized: boolean;
} {
  const minutes = Math.ceil(totalChars / readingSpeed.charsPerMinute);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  let displayText: string;
  if (minutes < 60) {
    displayText = `${minutes} min`;
  } else if (mins === 0) {
    displayText = `${hours}h`;
  } else {
    displayText = `${hours}h ${mins}m`;
  }

  return {
    minutes,
    hours,
    displayText,
    isPersonalized: readingSpeed.isPersonalized
  };
}
