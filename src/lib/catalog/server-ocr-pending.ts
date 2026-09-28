import { writable, type Readable } from 'svelte/store';
import type { ManifestPendingJob } from '$lib/import/deep-link-manifest';

/**
 * What the volume views show of a server's OCR queue: the jobs still pending
 * per volume, as `server-ocr-recheck.ts` last read them. Kept apart from that
 * module so a volume card does not import the recheck machinery.
 */

/** Written only by `server-ocr-recheck.ts`. */
export const pendingStore = writable<Record<string, ManifestPendingJob[] | null>>({});

/** volume_uuid → the server jobs still pending for it (null = queued, not read yet). */
export const serverOcrPending: Readable<Record<string, ManifestPendingJob[] | null>> = {
  subscribe: pendingStore.subscribe
};

function localHhMm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The chip: "OCR ~HH:MM" for the earliest priced job (local time, no seconds),
 * "OCR queued" when none is priced or the jobs are not known yet; the tooltip
 * lists every job. Null when nothing is pending.
 */
export function describePendingJobs(
  jobs: ManifestPendingJob[] | null | undefined
): { label: string; tooltip: string } | null {
  if (jobs === undefined) return null;
  if (jobs === null) {
    return { label: 'OCR queued', tooltip: 'The server has queued OCR for this volume' };
  }
  if (jobs.length === 0) return null;
  const priced = jobs
    .filter((j) => j.eta !== null)
    .sort((a, b) => Date.parse(a.eta!) - Date.parse(b.eta!));
  const label = priced.length > 0 ? `OCR ~${localHhMm(priced[0].eta!)}` : 'OCR queued';
  const tooltip = jobs
    .map(
      (j) =>
        `${j.id} ${j.kind === 'ocr' ? 'OCR' : 'layer'} ${j.eta ? `~${localHhMm(j.eta)}` : 'queued'}`
    )
    .join('\n');
  return { label, tooltip };
}
