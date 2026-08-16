import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { sortVolumes } from '$lib/catalog/sort-volumes';
import { archiveAndResetVolumes, volumes, type VolumeData } from '$lib/settings/volume-data';
import type { VolumeMetadata } from '$lib/types';
import { onSeriesRestarted } from './progress-tracker';
import { normalizeSeriesKey } from './series-key';
import { getSeriesMetadataForTitle, updateSeriesMetadata } from './store';
import type { SeriesMetadata } from './types';

const sessionKey = (seriesKey: string) => `reread_dismissed:${seriesKey}`;

/** Cloud-only placeholders (never downloaded) don't count as "read" or "unread" —
 * exclude them from both the "first volume" and "all completed" checks. */
const localOnly = (volumes: VolumeMetadata[]) => volumes.filter((v) => !v.isPlaceholder);

/**
 * Offer a restart only when the reader opens the FIRST local volume (sort order,
 * placeholders excluded) of a series whose every local volume is completed,
 * unless the user suppressed the prompt for this series or dismissed it this
 * session. Opening a later volume is browsing.
 */
export function shouldOfferReread(args: {
  volumeUuid: string;
  seriesVolumes: VolumeMetadata[];
  volumesData: Record<string, Pick<VolumeData, 'completed'> | undefined>;
  meta: SeriesMetadata | undefined;
  seriesKey: string;
}): boolean {
  const sorted = [...localOnly(args.seriesVolumes)].sort(sortVolumes);
  if (sorted.length === 0 || sorted[0].volume_uuid !== args.volumeUuid) return false;
  if (args.meta?.reread_prompt_suppressed) return false;
  if (browser && sessionStorage.getItem(sessionKey(args.seriesKey))) return false;
  return sorted.every((v) => args.volumesData[v.volume_uuid]?.completed === true);
}

export function dismissRereadForSession(seriesKey: string): void {
  if (browser) sessionStorage.setItem(sessionKey(seriesKey), '1');
}

export async function suppressRereadPrompt(seriesTitle: string): Promise<void> {
  await updateSeriesMetadata(seriesTitle, { reread_prompt_suppressed: true });
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

  const meta = await getSeriesMetadataForTitle(seriesTitle);
  await updateSeriesMetadata(seriesTitle, {
    read_count: (meta?.read_count ?? 0) + (wasFullyCompleted ? 1 : 0),
    reread_prompt_suppressed: false
  });
  if (browser) sessionStorage.removeItem(sessionKey(seriesKey));

  onSeriesRestarted(seriesKey);
}
