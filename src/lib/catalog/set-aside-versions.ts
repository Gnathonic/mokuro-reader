/**
 * The one-time fill of a set-aside main's version on this browser
 * (`backfillSetAsideLayerVersions`, `layer-store.ts`): rows stored before
 * layers were named by their maker. Runs until it once succeeds, then never
 * again (a done-marker in localStorage); idempotent if it runs twice.
 */
import { db } from './db';
import { backfillSetAsideLayerVersions } from './layer-store';

export const SET_ASIDE_VERSIONS_KEY = 'layers:set-aside-versions';

function alreadyDone(): boolean {
  try {
    return localStorage.getItem(SET_ASIDE_VERSIONS_KEY) === '1';
  } catch {
    return false;
  }
}

function markDone(): void {
  try {
    localStorage.setItem(SET_ASIDE_VERSIONS_KEY, '1');
  } catch {
    // Storage unavailable: the next start runs the (idempotent) fill again.
  }
}

/** Resolves the number of rows filled (0 once done). A failure throws and leaves the marker unset. */
export async function fillSetAsideLayerVersions(): Promise<number> {
  if (alreadyDone()) return 0;
  const filled = await backfillSetAsideLayerVersions(db);
  markDone();
  return filled;
}
