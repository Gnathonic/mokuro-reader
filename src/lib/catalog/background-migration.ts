import { db } from './db';
import { writable } from 'svelte/store';

export const migrationProgress = writable<{
  current: number;
  total: number;
  percent: number;
} | null>(null);

export const isMigrationComplete = writable<boolean>(false);

/**
 * Start background migration: Calculate characters_per_page for volumes with empty arrays.
 * Processes one volume at a time to avoid blocking UI.
 * Progress is tracked by counting volumes with empty characters_per_page arrays.
 */
export async function startBackgroundMigration(): Promise<void> {
  console.log('[Background Migration] Checking for pending volumes...');

  try {
    // Find volumes that need characters_per_page calculated (empty array)
    const allVolumes = await db.volumes.toArray();
    const volumesNeedingMigration = allVolumes.filter(
      v => !v.characters_per_page || v.characters_per_page.length === 0
    );

    if (volumesNeedingMigration.length === 0) {
      console.log('[Background Migration] No volumes need migration');
      isMigrationComplete.set(true);
      migrationProgress.set(null);
      return;
    }

    console.log(`[Background Migration] Found ${volumesNeedingMigration.length} volumes needing characters_per_page`);

    const totalCount = volumesNeedingMigration.length;
    let processed = 0;

    // Process volumes one at a time
    for (const volume of volumesNeedingMigration) {
      try {
        await calculateCharactersPerPage(volume.volume_uuid);

        processed++;
        const percent = Math.round((processed / totalCount) * 100);

        migrationProgress.set({
          current: processed,
          total: totalCount,
          percent
        });

        // Log every 10 volumes
        if (processed % 10 === 0) {
          console.log(`[Background Migration] ${processed}/${totalCount} (${percent}%)`);
        }

        // Throttle to avoid blocking UI (10ms pause every 5 volumes)
        if (processed % 5 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } catch (error) {
        console.error(`[Background Migration] Failed on volume ${volume.volume_uuid}:`, error);
        // Set empty array to mark as attempted (avoid infinite retry)
        await db.volumes.update(volume.volume_uuid, { characters_per_page: [] });
      }
    }

    console.log('[Background Migration] All volumes processed!');
    isMigrationComplete.set(true);
    migrationProgress.set(null);
  } catch (error) {
    console.error('[Background Migration] Fatal error:', error);
    migrationProgress.set(null);
  }
}

/**
 * Calculate characters_per_page for a single volume.
 * Loads from volumes_data table and updates volumes table.
 */
async function calculateCharactersPerPage(volumeUuid: string): Promise<void> {
  // Load volume data
  const volumeData = await db.volumes_data.get(volumeUuid);
  if (!volumeData || !volumeData.pages) {
    console.warn(`[Background Migration] No data found for volume ${volumeUuid}`);
    return;
  }

  // Calculate character stats
  const japaneseRegex = /[○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
  const charactersPerPage: number[] = [];
  let totalCharCount = 0;

  for (const page of volumeData.pages) {
    let pageCharCount = 0;
    if (page && page.blocks) {
      for (const block of page.blocks) {
        if (!block || !block.lines) continue;
        for (const line of block.lines) {
          if (typeof line !== 'string') continue;
          const chars = Array.from(line) as string[];
          pageCharCount += chars.filter((char) => japaneseRegex.test(char)).length;
        }
      }
    }
    charactersPerPage.push(pageCharCount);
    totalCharCount += pageCharCount;
  }

  // Update volume metadata with calculated character stats
  await db.volumes.update(volumeUuid, {
    character_count: totalCharCount,
    characters_per_page: charactersPerPage
  });
}
