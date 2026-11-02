import { derived } from 'svelte/store';
import { volumes, VolumeData } from './volume-data';
import { settings } from './settings';
import { calculateReadingSpeed, type ReadingSpeedResult } from '$lib/util/reading-speed';
import { db } from '$lib/catalog/db';
import type { Page } from '$lib/types';
import type { PageTurn } from './volume-data';

/**
 * Format volume name for logging: "Series/Volume (uuid)" or fallback to uuid
 */
function formatVolumeName(volumeData: VolumeData, volumeId: string): string {
  if (volumeData.series_title && volumeData.volume_title) {
    return `${volumeData.series_title}/${volumeData.volume_title} (${volumeId.slice(0, 8)}...)`;
  }
  return volumeId.slice(0, 8) + '...';
}

/**
 * Migrate 2-tuple page turn data to 3-tuple format by enriching with character counts from IndexedDB
 */
export async function migratePageTurnData(
  volumeId: string,
  volumeData: VolumeData,
  turns: PageTurn[]
): Promise<PageTurn[] | null> {
  // Check if already migrated (all turns are 3-tuple)
  if (turns.every((turn) => turn.length === 3)) {
    return null; // No migration needed
  }

  // Check if any are 2-tuple format (runtime check - type says 3 but old data may be 2)
  const has2Tuple = turns.some((turn) => (turn as number[]).length === 2);
  if (!has2Tuple) {
    return null; // No migration needed
  }

  const volumeName = formatVolumeName(volumeData, volumeId);
  console.log(`[Migration] Attempting to migrate ${volumeName} (${turns.length} turns)`);

  try {
    // Load pages from IndexedDB (from volume_ocr table)
    const volumeOcr = await db.volume_ocr.get(volumeId);
    if (!volumeOcr || !volumeOcr.pages) {
      console.log(`[Migration] Failed - no pages in IndexedDB for ${volumeName}`);
      return null;
    }

    const pages = volumeOcr.pages as Page[];

    // Helper to get character count for a page
    const getPageChars = (pageNum: number): number => {
      const page = pages[pageNum];
      if (!page) return 0;
      return page.blocks.reduce((sum, block) => {
        return sum + block.lines.reduce((lineSum, line) => lineSum + line.length, 0);
      }, 0);
    };

    // Build cumulative character counts
    let cumulativeChars = 0;
    const migratedTurns: PageTurn[] = turns.map((turn, i) => {
      if (turn.length === 3) {
        // Already migrated, update cumulative counter
        cumulativeChars = turn[2];
        return turn;
      }

      // 2-tuple format - need to add character count
      const [timestamp, page] = turn;

      // For the first turn, cumulative is just this page
      // For subsequent turns, add the chars from the previous page
      if (i > 0) {
        const prevPage = turns[i - 1][1];
        cumulativeChars += getPageChars(prevPage);
      } else {
        // First turn - start at 0 or could calculate from page 0 to current
        for (let p = 0; p <= page; p++) {
          cumulativeChars += getPageChars(p);
        }
      }

      return [timestamp, page, cumulativeChars] as PageTurn;
    });

    console.log(`[Migration] Successfully migrated ${volumeName}`);
    return migratedTurns;
  } catch (error) {
    console.warn(`[Migration] Failed for ${volumeName}`, error);
    return null;
  }
}

/**
 * Personalized reading speed derived from hybrid approach:
 * - Prioritizes up to 4 hours of recent page-level session data
 * - Fills remaining time (up to 8 hours total) with completed volume data
 *
 * Character counts are stored in page turns, so no IndexedDB pages needed.
 */
export const personalizedReadingSpeed = derived<
  [typeof volumes, typeof settings],
  ReadingSpeedResult
>(
  [volumes, settings],
  ([$volumes, $settings], set) => {
    const idleTimeoutMinutes = $settings.inactivityTimeoutMinutes;

    // No write-back migration any more: `$volumes` turns are projected from
    // reading history (phase 2b) and must never be written into the stored
    // records. Legacy 2-tuples are upgraded when they are converted instead.
    set(calculateReadingSpeed($volumes, idleTimeoutMinutes));
  },
  // Initial value
  {
    charsPerMinute: 100,
    isPersonalized: false,
    confidence: 'none' as const,
    sessionsUsed: 0
  }
);
