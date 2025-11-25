import type { VolumeData, Page } from '$lib/types';

/**
 * Get the current working version of pages.
 * Returns edited version if it exists, otherwise original.
 */
export function getCurrentPages(volumeData: VolumeData): Page[] {
  return volumeData.edited_pages ?? volumeData.pages;
}

/**
 * Check if volume has edits
 */
export function hasEdits(volumeData: VolumeData): boolean {
  return volumeData.edited_pages !== undefined;
}

/**
 * Get original pages (for reference in editor)
 */
export function getOriginalPages(volumeData: VolumeData): Page[] {
  return volumeData.pages;
}
