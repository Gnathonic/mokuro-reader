/**
 * The one-time removal of v1.10.0's "Previous OCR" keepsakes on this browser
 * (the OCR upgrade no longer keeps one — CLAUDE.md, "OCR upgrades").
 *
 * The storage side is `deleteRetiredPreviousOcrLayers` (`layer-store.ts`);
 * this adds what only the main thread knows: which layer each volume displays
 * (its `ocrLayer` setting, read live so a pick made while the cleanup runs
 * still counts), and a done-marker, so it runs until it once succeeds and
 * never again. Nothing can make a new keepsake, and whatever it leaves behind
 * was claimed — edited, renamed or on screen — so it is an ordinary layer
 * from then on, even if the user later switches away from it.
 */
import { get } from 'svelte/store';
import { db } from './db';
import { deleteRetiredPreviousOcrLayers } from './layer-store';
import { volumesWithTrash } from '$lib/settings/volume-data';

export const PREVIOUS_OCR_RETIRED_KEY = 'layers:previous-ocr-retired';

function alreadyDone(): boolean {
  try {
    return localStorage.getItem(PREVIOUS_OCR_RETIRED_KEY) === '1';
  } catch {
    return false;
  }
}

function markDone(): void {
  try {
    localStorage.setItem(PREVIOUS_OCR_RETIRED_KEY, '1');
  } catch {
    // Storage unavailable: the next start runs the (idempotent) cleanup again.
  }
}

/** Resolves the number of layers deleted (0 once done). A failure throws and
 * leaves the marker unset, so the next start retries. */
export async function retirePreviousOcrLayers(): Promise<number> {
  if (alreadyDone()) return 0;
  const deleted = await deleteRetiredPreviousOcrLayers(
    db,
    (volumeUuid, layerId) => get(volumesWithTrash)[volumeUuid]?.settings?.ocrLayer === layerId
  );
  markDone();
  return deleted;
}
