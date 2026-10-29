/**
 * Which position stamps of a watched volume have left this device: the newest
 * one uploaded in `positions.json` or `volume-data.json`. A look-up visit
 * (`visit.ts`) that comes home restores the old position; when one of its own
 * stamps already went up, the old stamp would lose to it, so the restore is
 * written 1 ms above the newest upload instead. No imports, so both sync
 * paths can report into it cheaply.
 */

const uploaded = new Map<string, number>();

export function watchEscapes(volume: string): void {
  if (!uploaded.has(volume)) uploaded.set(volume, 0);
}

export function unwatchEscapes(volume: string): void {
  uploaded.delete(volume);
}

/** Every watched volume (the sync reports only these). */
export function watchedEscapes(): string[] {
  return [...uploaded.keys()];
}

/** Keeps the max, and only while the volume is watched. */
export function noteUploaded(volume: string, t: number): void {
  const newest = uploaded.get(volume);
  if (newest === undefined || !Number.isFinite(t)) return;
  if (t > newest) uploaded.set(volume, t);
}

/** 0 = nothing uploaded since the watch began. */
export function newestUploaded(volume: string): number {
  return uploaded.get(volume) ?? 0;
}

export function _resetEscapesForTests(): void {
  uploaded.clear();
}
