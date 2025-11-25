/**
 * Test fixtures and factory functions for creating mock data
 */

import type { Page, Block, VolumeMetadata } from '$lib/types';
import type { VolumeSpeedData } from '$lib/util/reading-speed-history';
import type { ReadingSpeedResult } from '$lib/util/reading-speed';

// ============================================================================
// Page Fixtures
// ============================================================================

/**
 * Create a minimal Page object for testing
 */
export function createPage(
  width: number = 1000,
  height: number = 1500,
  blocks: Block[] = []
): Page {
  return {
    version: '0.2.0',
    img_width: width,
    img_height: height,
    img_path: 'test-image.jpg',
    blocks
  };
}

/**
 * Create a Page with text blocks
 */
export function createPageWithText(
  text: string[],
  width: number = 1000,
  height: number = 1500
): Page {
  const blocks: Block[] = text.map((line, i) => ({
    box: [0, i * 50, 100, (i + 1) * 50],
    vertical: false,
    font_size: 16,
    lines: [line]
  }));

  return createPage(width, height, blocks);
}

/**
 * Create a wide spread page (landscape, aspect ratio > 1.2)
 */
export function createWideSpreadPage(): Page {
  return createPage(2000, 1000); // Aspect ratio 2.0
}

/**
 * Create a portrait page
 */
export function createPortraitPage(width: number = 1000): Page {
  return createPage(width, 1500);
}

// ============================================================================
// Volume Metadata Fixtures
// ============================================================================

/**
 * Create a minimal VolumeMetadata object for testing
 */
export function createVolumeMetadata(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: `vol-${Math.random().toString(36).slice(2, 10)}`,
    series_uuid: 'series-uuid',
    series_title: 'Test Series',
    volume_title: 'Volume 1',
    page_count: 100,
    character_count: 5000,
    mokuro_version: '0.2.0',
    ...overrides
  };
}

/**
 * Create a placeholder volume (from cloud storage)
 */
export function createPlaceholderVolume(
  provider: 'google-drive' | 'mega' | 'webdav' = 'google-drive',
  overrides: Partial<VolumeMetadata> = {}
): VolumeMetadata {
  return createVolumeMetadata({
    isPlaceholder: true,
    cloudProvider: provider,
    cloudFileId: `file-${Math.random().toString(36).slice(2, 10)}`,
    cloudModifiedTime: new Date().toISOString(),
    cloudSize: 10000000,
    ...overrides
  });
}

/**
 * Create a legacy Drive volume (old format)
 */
export function createLegacyDriveVolume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return createVolumeMetadata({
    isPlaceholder: true,
    driveFileId: `legacy-${Math.random().toString(36).slice(2, 10)}`,
    driveModifiedTime: new Date().toISOString(),
    driveSize: 10000000,
    ...overrides
  });
}

// ============================================================================
// Volume Progress/Data Fixtures
// ============================================================================

/**
 * Create volume progress data for reading speed calculations
 */
export function createVolumeProgress(
  overrides: Partial<{
    completed: boolean;
    timeReadInMinutes: number;
    chars: number;
    lastProgressUpdate: string;
    recentPageTurns: [number, number, number][];
    series_title: string;
    series_uuid: string;
    volume_title: string;
  }> = {}
) {
  return {
    completed: false,
    timeReadInMinutes: 0,
    chars: 0,
    lastProgressUpdate: new Date().toISOString(),
    series_title: 'Test Series',
    series_uuid: 'series-uuid',
    volume_title: 'Volume 1',
    ...overrides
  };
}

/**
 * Create a completed volume with reading stats
 */
export function createCompletedVolume(
  charsPerMinute: number = 100,
  durationMinutes: number = 60,
  completionDate: Date = new Date()
) {
  const chars = charsPerMinute * durationMinutes;
  return createVolumeProgress({
    completed: true,
    timeReadInMinutes: durationMinutes,
    chars,
    lastProgressUpdate: completionDate.toISOString()
  });
}

// ============================================================================
// Reading Speed Fixtures
// ============================================================================

/**
 * Create a ReadingSpeedResult for testing
 */
export function createReadingSpeedResult(
  overrides: Partial<ReadingSpeedResult> = {}
): ReadingSpeedResult {
  return {
    charsPerMinute: 100,
    isPersonalized: false,
    confidence: 'none',
    sessionsUsed: 0,
    ...overrides
  };
}

/**
 * Create a personalized reading speed result
 */
export function createPersonalizedSpeed(
  cpm: number = 150,
  confidence: 'high' | 'medium' | 'low' = 'high'
): ReadingSpeedResult {
  return createReadingSpeedResult({
    charsPerMinute: cpm,
    isPersonalized: true,
    confidence,
    sessionsUsed: 3
  });
}

// ============================================================================
// Volume Speed Data Fixtures
// ============================================================================

/**
 * Create VolumeSpeedData for reading history tests
 */
export function createVolumeSpeedData(overrides: Partial<VolumeSpeedData> = {}): VolumeSpeedData {
  return {
    volumeId: `vol-${Math.random().toString(36).slice(2, 10)}`,
    volumeTitle: 'Volume 1',
    seriesTitle: 'Test Series',
    seriesId: 'series-uuid',
    completionDate: new Date(),
    durationMinutes: 60,
    charsRead: 6000,
    charsPerMinute: 100,
    isPersonalBest: false,
    isSlowest: false,
    percentVsAverage: 0,
    ...overrides
  };
}

// ============================================================================
// Page Turn Fixtures
// ============================================================================

/**
 * Create page turns for reading speed tests
 * Returns 3-tuple format: [timestamp_ms, page_number, cumulative_char_count]
 */
export function createPageTurns(
  pageCount: number,
  charsPerPage: number = 100,
  secondsPerPage: number = 60,
  startTime: number = Date.now() - pageCount * secondsPerPage * 1000
): [number, number, number][] {
  const turns: [number, number, number][] = [];
  let cumulativeChars = 0;
  let time = startTime;

  for (let page = 0; page <= pageCount; page++) {
    turns.push([time, page, cumulativeChars]);
    cumulativeChars += charsPerPage;
    time += secondsPerPage * 1000;
  }

  return turns;
}

// ============================================================================
// Catalog Fixtures
// ============================================================================

/**
 * Create a catalog of volumes for testing
 */
export function createCatalog(count: number = 3): VolumeMetadata[] {
  return Array.from({ length: count }, (_, i) =>
    createVolumeMetadata({
      volume_uuid: `vol-${i + 1}`,
      volume_title: `Volume ${i + 1}`,
      page_count: 100 + i * 10,
      character_count: 5000 + i * 1000
    })
  );
}

// ============================================================================
// Time Helpers
// ============================================================================

/**
 * Create a date relative to now
 */
export function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

/**
 * Create an ISO string date relative to now
 */
export function daysAgoISO(days: number): string {
  return daysAgo(days).toISOString();
}
