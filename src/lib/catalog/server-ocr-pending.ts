import { readable, writable, type Readable } from 'svelte/store';
import type { ManifestPendingJob } from '$lib/import/deep-link-manifest';
import { layerNameForId } from '$lib/reader/edit/layer-names';

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

/**
 * The clock the relative times are read against: one shared interval for
 * every card (started by the first subscriber, stopped with the last), so a
 * minute passing re-derives the chip text only — never the whole card.
 */
export const pendingOcrClock: Readable<number> = readable(Date.now(), (set) => {
  // Fresh on every (re)start: the initial value above dates from module load.
  set(Date.now());
  const timer = setInterval(() => set(Date.now()), 30_000);
  return () => clearInterval(timer);
});

function localHhMm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "in ~3 min" + local "08:17"; "queued" (no clock) unpriced; "any moment" once overdue. */
export function relativeEta(
  eta: string | null,
  now: number
): { when: string; clock: string | null } {
  if (eta === null) return { when: 'queued', clock: null };
  const at = Date.parse(eta);
  if (!Number.isFinite(at)) return { when: 'queued', clock: null };
  const clock = localHhMm(at);
  const ms = at - now;
  if (ms <= 0) return { when: 'any moment', clock };
  if (ms < 60_000) return { when: 'in <1 min', clock };
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return { when: `in ~${minutes} min`, clock };
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return { when: m === 0 ? `in ~${h} h` : `in ~${h} h ${m} min`, clock };
}

/** Longest name a line shows before an ellipsis (the label keeps it whole). */
const MAX_NAME = 16;

function shorten(name: string): string {
  return name.length <= MAX_NAME ? name : `${name.slice(0, MAX_NAME - 1).trimEnd()}…`;
}

export interface PendingOcrLine {
  /** Stable per job (`kind:id`): a landed job's line leaves without disturbing the rest. */
  key: string;
  /** "Text" for the primary, else the layer's display name, shortened. */
  name: string;
  fullName: string;
  when: string;
  /** Local HH:MM, or null when the server gave no estimate. */
  clock: string | null;
}

export interface PendingOcrView {
  title: string;
  /** Every pending job: the primary first, then by ETA, unpriced last. */
  lines: PendingOcrLine[];
  /** What a compact surface shows (at most `maxLines`, counting a "+N more" line). */
  shown: PendingOcrLine[];
  more: number;
  /** The list view's single line: "Server OCR: Text in ~3 min · Hayai Nova in ~8 min · …". */
  inline: string;
  /** Tooltip / aria-label: every job, its full name and exact clock time. */
  label: string;
}

const TITLE = 'Server OCR';

/**
 * What the volume views say about OCR the server is still making for a volume.
 * `jobs` null = the server queued it but the jobs are not known yet; undefined
 * or empty = nothing pending (null result). `now` is the refreshing clock.
 */
export function describePendingOcr(
  jobs: ManifestPendingJob[] | null | undefined,
  now: number,
  maxLines = 3
): PendingOcrView | null {
  if (jobs === undefined || (jobs !== null && jobs.length === 0)) return null;
  if (jobs === null) {
    const line = { key: 'queued', name: 'OCR', fullName: 'OCR', when: 'queued', clock: null };
    return {
      title: TITLE,
      lines: [line],
      shown: [line],
      more: 0,
      inline: `${TITLE}: queued`,
      label: `${TITLE} — queued, no estimate yet`
    };
  }
  const etaOf = (j: ManifestPendingJob) => (j.eta === null ? Infinity : Date.parse(j.eta));
  const ordered = [...jobs].sort(
    (a, b) => (a.kind === 'ocr' ? 0 : 1) - (b.kind === 'ocr' ? 0 : 1) || etaOf(a) - etaOf(b)
  );
  const lines: PendingOcrLine[] = ordered.map((job) => {
    const fullName = job.kind === 'ocr' ? 'Text' : layerNameForId(job.id);
    return {
      key: `${job.kind}:${job.id}`,
      name: shorten(fullName),
      fullName,
      ...relativeEta(job.eta, now)
    };
  });
  const fits = lines.length <= maxLines;
  const shown = fits ? lines : lines.slice(0, maxLines - 1);
  return {
    title: TITLE,
    lines,
    shown,
    more: lines.length - shown.length,
    inline: `${TITLE}: ${lines.map((l) => `${l.name} ${l.when}`).join(' · ')}`,
    label:
      `${TITLE} — ` +
      lines
        .map(
          (l) =>
            `${l.fullName}: ${l.when}${l.clock && l.when !== 'queued' ? `, at ${l.clock}` : ', no estimate yet'}`
        )
        .join('; ')
  };
}
