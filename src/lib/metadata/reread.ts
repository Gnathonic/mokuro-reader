import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { sortVolumes } from '$lib/catalog/sort-volumes';
import { archiveAndResetVolumes, volumes, type VolumeData } from '$lib/settings/volume-data';
import { updateSeriesReadingState } from '$lib/settings/series-data';
import type { VolumeMetadata } from '$lib/types';
import { onSeriesRestarted } from './progress-tracker';
import { normalizeSeriesKey } from './series-key';

const sessionKey = (seriesKey: string) => `reread_dismissed:${seriesKey}`;

/** Cloud-only placeholders (never downloaded) don't count as "read" or "unread" —
 * exclude them from both the "first volume" and "all completed" checks. */
const localOnly = (volumes: VolumeMetadata[]) => volumes.filter((v) => !v.isPlaceholder);

/**
 * Offer a restart only when the reader opens the FIRST local volume (sort order,
 * placeholders excluded) of a series whose every local volume is completed,
 * unless the user suppressed the prompt for this series or dismissed it this
 * session. Opening a later volume is browsing.
 *
 * `suppressed` is passed in rather than read here: it lives in the reading-state
 * store, which the caller already holds (synchronously — no DB round trip).
 */
export function shouldOfferReread(args: {
  volumeUuid: string;
  seriesVolumes: VolumeMetadata[];
  volumesData: Record<string, Pick<VolumeData, 'completed'> | undefined>;
  suppressed: boolean;
  seriesKey: string;
}): boolean {
  const sorted = [...localOnly(args.seriesVolumes)].sort(sortVolumes);
  if (sorted.length === 0 || sorted[0].volume_uuid !== args.volumeUuid) return false;
  if (args.suppressed) return false;
  if (browser && sessionStorage.getItem(sessionKey(args.seriesKey))) return false;
  return sorted.every((v) => args.volumesData[v.volume_uuid]?.completed === true);
}

export function dismissRereadForSession(seriesKey: string): void {
  if (browser) sessionStorage.setItem(sessionKey(seriesKey), '1');
}

export function suppressRereadPrompt(seriesTitle: string): void {
  updateSeriesReadingState(normalizeSeriesKey(seriesTitle), { reread_prompt_suppressed: true });
}

/**
 * Restart series: archive every local volume's current read (stats kept), reset
 * to the start, bump read_count when the whole (local) series had been read,
 * clear the prompt suppression, and tell the tracker (REPEATING / progress 0).
 * Placeholders (cloud-only, never downloaded) are neither archived/reset nor
 * counted toward "was fully completed".
 */
export async function restartSeries(
  seriesTitle: string,
  seriesVolumes: VolumeMetadata[]
): Promise<void> {
  const seriesKey = normalizeSeriesKey(seriesTitle);
  const local = localOnly(seriesVolumes);
  const data = get(volumes);
  const wasFullyCompleted =
    local.length > 0 && local.every((v) => data[v.volume_uuid]?.completed === true);

  archiveAndResetVolumes(local.map((v) => v.volume_uuid));

  // Functional patch: the tracker writes `tracking.last_pushed` for the same
  // series from another module.
  updateSeriesReadingState(seriesKey, (existing) => ({
    read_count: wasFullyCompleted ? existing.read_count + 1 : existing.read_count,
    reread_prompt_suppressed: undefined
  }));
  if (browser) sessionStorage.removeItem(sessionKey(seriesKey));

  onSeriesRestarted(seriesKey);
}
