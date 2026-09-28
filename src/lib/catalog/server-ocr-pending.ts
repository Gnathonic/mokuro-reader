import { readable, writable, type Readable } from 'svelte/store';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import { layerNameForId } from '$lib/reader/edit/layer-names';

/**
 * What the volume views show of a server's OCR queue — the light half of
 * `server-ocr-queue.ts`, which polls `<dav root>/.mokuro-queue.json` and writes
 * the stores below. Kept apart so a volume card imports no polling machinery.
 */

/** One job of a volume in the queue file. */
export interface QueueJob {
  kind: 'ocr' | 'layer';
  /** The generation name; the layer id for a layer. */
  id: string;
  state: 'running' | 'queued' | 'held';
  /** ISO finishing time the server predicts, or null when it cannot price it. */
  eta: string | null;
  /** 0–1 while running, else null. */
  progress: number | null;
}

/** Why the whole queue is held (plain codes only). */
export interface QueueHeld {
  reason: string;
}

/** What one volume is waiting for. */
export interface VolumeQueueStatus {
  jobs: QueueJob[];
  held: QueueHeld | null;
}

/** The matching key between a queue entry and a local row: folded series + volume title. */
export function volumeQueueKey(series: string, volume: string): string {
  return `${normalizeSeriesKey(series)}\u0000${normalizeVolumeTitleKey(volume)}`;
}

/** Written only by `server-ocr-queue.ts`: volume key → its jobs, across every polled server. */
export const queueStatusStore = writable<Record<string, VolumeQueueStatus>>({});

/** volume key → what the server's queue says about it. */
export const serverOcrQueueStatus: Readable<Record<string, VolumeQueueStatus>> = {
  subscribe: queueStatusStore.subscribe
};

/**
 * volume_uuid → the queue key a watched volume goes by on its server, for rows
 * whose own titles differ from the server's folder/file names (a deep-linked
 * volume keeps the titles inside its `.mokuro`). Written by `server-ocr-queue.ts`.
 */
export const watchedKeyStore = writable<Record<string, string>>({});

/** The key a card looks its volume up by. */
export function queueKeyForVolume(
  volume: { volume_uuid: string; series_title: string; volume_title: string },
  watched: Record<string, string>
): string {
  return watched[volume.volume_uuid] ?? volumeQueueKey(volume.series_title, volume.volume_title);
}

// ---- volumes the catalog is showing: a reason to keep polling ----

const shown = new Map<string, number>();
let shownListener: (() => void) | null = null;

/** Set by `server-ocr-queue.ts` once it runs: told whenever a card starts showing a volume. */
export function setShownListener(listener: (() => void) | null): void {
  shownListener = listener;
}

/** A card showing this volume registers it; the returned function unregisters it. */
export function markVolumeShown(key: string): () => void {
  shown.set(key, (shown.get(key) ?? 0) + 1);
  shownListener?.();
  return () => {
    const n = (shown.get(key) ?? 1) - 1;
    if (n <= 0) shown.delete(key);
    else shown.set(key, n);
  };
}

export function isVolumeShown(key: string): boolean {
  return shown.has(key);
}

// ---- rendering ----

/**
 * The clock relative times are read against: one shared interval for every
 * card (started by the first subscriber, stopped with the last), so a minute
 * passing re-derives the status text only — never the whole card.
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

const HELD_TEXT: Readonly<Record<string, string>> = {
  'no-processor': 'held: no processor connected',
  paused: 'held: queue paused',
  benchmarking: 'held: benchmarking'
};

/** A held code in plain words; an unknown (newer) code is just "held". */
export function heldText(held: QueueHeld | null): string {
  return (held && HELD_TEXT[held.reason]) ?? 'held';
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
  /** Beside the name on a cover: "42% · ~08:17", "in ~3 min · 08:17", "queued", "held: …". */
  detail: string;
  /** In the one-line list form: the same without a queued job's clock. */
  short: string;
  /** For the tooltip / label, the exact clock time spelled out. */
  spoken: string;
}

export interface PendingOcrView {
  title: string;
  /** Every pending job: the primary first, then by ETA, unpriced last. */
  lines: PendingOcrLine[];
  /** What a compact surface shows (at most `maxLines`, counting a "+N more" line). */
  shown: PendingOcrLine[];
  more: number;
  /** The list view's single line: "Server OCR: Text 42% · ~08:17 · Hayai Nova in ~8 min · …". */
  inline: string;
  /** Tooltip / aria-label: every job, its full name and exact clock time. */
  label: string;
}

const TITLE = 'Server OCR';

function lineFor(job: QueueJob, held: QueueHeld | null, now: number): PendingOcrLine {
  const fullName = job.kind === 'ocr' ? 'Text' : layerNameForId(job.id);
  const base = { key: `${job.kind}:${job.id}`, name: shorten(fullName), fullName };
  const { when, clock } = relativeEta(job.eta, now);
  if (job.state === 'held') {
    const text = heldText(held);
    return { ...base, detail: text, short: text, spoken: text };
  }
  if (job.state === 'running') {
    const pct =
      typeof job.progress === 'number' && Number.isFinite(job.progress)
        ? `${Math.round(Math.min(Math.max(job.progress, 0), 1) * 100)}%`
        : null;
    const parts = [pct, clock ? `~${clock}` : null].filter(Boolean);
    const detail = parts.length ? parts.join(' · ') : 'running';
    const spoken =
      'running' +
      (pct ? `, ${pct} done` : '') +
      (clock ? `, finishing about ${clock}` : ', no estimate yet');
    return { ...base, detail, short: detail, spoken };
  }
  const priced = clock !== null && when !== 'queued';
  return {
    ...base,
    detail: priced ? `${when} · ${clock}` : when,
    short: when,
    spoken: priced ? `${when}, at ${clock}` : `${when}, no estimate yet`
  };
}

/**
 * What the volume views say about OCR the server is still making for a volume,
 * from its entry in the queue file. Null when nothing is pending.
 */
export function describePendingOcr(
  status: VolumeQueueStatus | undefined,
  now: number,
  maxLines = 3
): PendingOcrView | null {
  if (!status || status.jobs.length === 0) return null;
  const etaOf = (j: QueueJob) => (j.eta === null ? Infinity : Date.parse(j.eta));
  const ordered = [...status.jobs].sort(
    (a, b) => (a.kind === 'ocr' ? 0 : 1) - (b.kind === 'ocr' ? 0 : 1) || etaOf(a) - etaOf(b)
  );
  const lines = ordered.map((job) => lineFor(job, status.held, now));
  const shown = lines.length <= maxLines ? lines : lines.slice(0, maxLines - 1);
  return {
    title: TITLE,
    lines,
    shown,
    more: lines.length - shown.length,
    inline: `${TITLE}: ${lines.map((l) => `${l.name} ${l.short}`).join(' · ')}`,
    label: `${TITLE} — ${lines.map((l) => `${l.fullName}: ${l.spoken}`).join('; ')}`
  };
}
