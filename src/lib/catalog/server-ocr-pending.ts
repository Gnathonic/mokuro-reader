import { readable, writable, type Readable } from 'svelte/store';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import { ocrFileLabel, validParts, type OcrPart } from '$lib/reader/edit/ocr-label';

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
  /**
   * What the job will make the OCR with, in `ocr_engine.parts` shape (bunko
   * 0.8+): names the line as the finished file will be named. Absent from an
   * older bunko, or dropped when malformed (the job itself stays).
   */
  parts?: OcrPart[];
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
  benchmarking: 'held: benchmarking',
  // A cloud-direct Bunko (library on Drive / OneDrive / MEGA / WebDAV) holds
  // its queue for reasons of the storage it writes to.
  'storage-offline': "held: Bunko can't reach your storage",
  'storage-auth': 'held: Bunko needs you to sign in to your storage again',
  'storage-full': 'held: your storage is full',
  'transfer-quota': 'held: storage transfer limit reached',
  'storage-lease': 'held: another Bunko manages this library'
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

/**
 * The short names a job's line may take, plainest first: with parts, the
 * recognizer alone, then every part without versions ("Hayai Nova ·
 * AnimeText"), then the full label; without, its full name.
 */
function compactNames(job: QueueJob, fullName: string): string[] {
  const parts = validParts(job.parts);
  if (!parts) return [fullName];
  const names = [parts[0].name];
  if (parts.length > 1) names.push(parts.map((p) => p.name).join(' · '));
  names.push(fullName);
  return names;
}

/**
 * Each line's short name: the plainest that, cut to `MAX_NAME`, no other line
 * of the volume shares — so "Hayai Nova 2.5 · PP-OCR Manga 0.3" and "Hayai
 * Nova 2.5 · AnimeText 12x" never both read "Hayai Nova 2.5…". Lines that
 * collide take their next form until they differ or have none left.
 */
function distinctShortNames(candidates: string[][]): string[] {
  const level = candidates.map(() => 0);
  const shortOf = (i: number) => shorten(candidates[i][level[i]]);
  for (;;) {
    const byShort = new Map<string, number[]>();
    candidates.forEach((_, i) => {
      const key = shortOf(i);
      byShort.set(key, [...(byShort.get(key) ?? []), i]);
    });
    let bumped = false;
    for (const group of byShort.values()) {
      if (group.length < 2) continue;
      for (const i of group) {
        if (level[i] + 1 < candidates[i].length) {
          level[i]++;
          bumped = true;
        }
      }
    }
    if (!bumped) return candidates.map((_, i) => shortOf(i));
  }
}

export interface PendingOcrLine {
  /** Stable per job (`kind:id`): a landed job's line leaves without disturbing the rest. */
  key: string;
  /**
   * What the job will make, short: its recognizer ("Hayai Nova"), with the
   * other parts only where two lines would otherwise read the same; cut to
   * `MAX_NAME`. Without parts, its full name cut.
   */
  name: string;
  /** Named as the finished file will be (`ocrFileLabel`): "Hayai Nova 2.5 · PP-OCR Manga 0.3". */
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
  /** Every pending job, soonest first: running, then queued by ETA, then unpriced and held. */
  lines: PendingOcrLine[];
  /** What a compact surface shows (at most `maxLines`, counting a "+N more" line). */
  shown: PendingOcrLine[];
  more: number;
  /** The list view's single line: "Server OCR: Hayai Nova 42% · ~08:17 · Paddle Manga in ~8 min · …". */
  inline: string;
  /** Tooltip / aria-label: every job, its full name and exact clock time. */
  label: string;
}

const TITLE = 'Server OCR';

/**
 * The main file and a layer alike: the job's parts ("Hayai Nova 2.5 ·
 * PP-OCR Manga 0.3"), else its generation's display name — never "Text".
 */
function fullNameOf(job: QueueJob): string {
  return ocrFileLabel({ engine: job.id, parts: job.parts });
}

function lineFor(job: QueueJob, name: string, held: QueueHeld | null, now: number): PendingOcrLine {
  const base = { key: `${job.kind}:${job.id}`, name, fullName: fullNameOf(job) };
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

/** Running first, then queued with an ETA, then unpriced and held (`soonestFirst`). */
function rankOf(job: QueueJob): number {
  if (job.state === 'running') return 0;
  if (job.state === 'queued' && job.eta !== null) return 1;
  return 2;
}

function etaOf(job: QueueJob): number {
  const t = job.eta === null ? NaN : Date.parse(job.eta);
  return Number.isFinite(t) ? t : Infinity;
}

/**
 * Soonest first, whatever the job makes (a main file due in days must not sit
 * above a layer due in minutes): running jobs by ETA, then queued ones by ETA,
 * then the unpriced and the held. Ties keep the server's order (a stable sort).
 */
function soonestFirst(a: QueueJob, b: QueueJob): number {
  const rank = rankOf(a) - rankOf(b);
  if (rank !== 0) return rank;
  if (rankOf(a) === 2) return 0;
  const ea = etaOf(a);
  const eb = etaOf(b);
  return ea === eb ? 0 : ea < eb ? -1 : 1;
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
  const ordered = [...status.jobs].sort(soonestFirst);
  const names = distinctShortNames(ordered.map((job) => compactNames(job, fullNameOf(job))));
  const lines = ordered.map((job, i) => lineFor(job, names[i], status.held, now));
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
