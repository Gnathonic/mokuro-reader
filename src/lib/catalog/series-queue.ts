/**
 * OCR queue file v2 (bunko `docs/design/queue-file-v2.md`): one file per
 * series folder, `<Series>/.mokuro-series-queue.json`, listing every OCR job
 * Bunko still owes that series. Pure: parsing, the work clock, trust and the
 * per-series slice the volume cards read. The loop that reads it lives in
 * `series-queue-loop.ts`.
 *
 * ```json
 * {"v":2,"instance_id":"8d2c…","rev":48211,"at":1794398520,"clock_at":1794398400,
 *  "series":"Example Saga",
 *  "rows":[{"kind":"ocr","id":"hayai-nova","parts":[…]},{"kind":"layer","id":"paddle"}],
 *  "vols":{"Example Saga 03":[[0,"r",1794398340,1794398760]],
 *          "Example Saga 04":[[0,"q",1794400200],[1,"q",1795310000]],
 *          "Example Saga 05":[[0,"c"]],"Example Saga 06":[[0,"q",null]]},
 *  "done":{"Example Saga 01":1794395000}}
 * ```
 *
 * Times are epoch SECONDS. A queued job carries a work position `w`, not a
 * time: its ETA is `clock(w)`, under the work clock of the lease marker's
 * `series_queue` block (a stored copy) or the file's own `live` block (Bunko's
 * virtual file over HTTP). A fleet speed change or a pause moves only the
 * clock, so the series files are not rewritten for it.
 */
import { normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import { validParts, type OcrPart } from '$lib/reader/edit/ocr-label';
import type { QueueHeld, QueueJob, VolumeQueueStatus } from './server-ocr-pending';

// ---------------------------------------------------------------- the format

/** One knot `[w, t]` of the work clock. */
export type ClockKnot = readonly [number, number];

/** A row the file refers to (`rows[i]`): what its jobs make. */
export interface SeriesQueueRow {
  kind: 'ocr' | 'layer';
  /** The same value a v1 job's `id` carried: the generation name or layer id. */
  id: string;
  parts?: OcrPart[];
}

/** One owed (volume, row) of the series. `row` indexes `rows`. */
export type SeriesQueueJob =
  /** Queued: `w` is the work position, null when unpriced (or in failure backoff). */
  | { row: number; state: 'q'; w: number | null }
  /** Claimed, not started. */
  | { row: number; state: 'c' }
  /** Running since `t0`; `e` is the predicted finish, null when unknown. */
  | { row: number; state: 'r'; t0: number; e: number | null };

/**
 * Library-wide queue state: the marker's `series_queue` block, or a virtual
 * file's `live` block (a local library has no marker).
 */
export interface SeriesQueueBlock {
  /** The whole queue is held (`{reason}` with Bunko's codes), or null. */
  held: QueueHeld | null;
  /** Row ids no open lane can take now: their jobs show as held. */
  held_rows: string[];
  /** The work clock, or null when the block carried none that is valid. */
  clock: ClockKnot[] | null;
  clock_at: number | null;
  /** This store's write window W, seconds; null when absent. */
  batch_s: number | null;
}

export interface SeriesQueueFile {
  v: 2;
  instance_id: string;
  rev: number;
  at: number;
  clock_at: number;
  /** The folder spelling Bunko wrote, for information only. */
  series: string;
  /** Null where a row was malformed: the jobs that name it are dropped. */
  rows: Array<SeriesQueueRow | null>;
  /** Archive stem (as spelled) → its jobs, never empty. One key per folded stem. */
  vols: Map<string, SeriesQueueJob[]>;
  /** Archive stem → epoch seconds its last job settled. */
  done: Map<string, number>;
  /** Bunko's virtual file over HTTP only; a stored copy never carries it. */
  live: SeriesQueueBlock | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 2 to 16 knots `[w, t]`, strictly increasing in both; null otherwise. */
export function parseClock(v: unknown): ClockKnot[] | null {
  if (!Array.isArray(v) || v.length < 2 || v.length > 16) return null;
  const knots: ClockKnot[] = [];
  for (const k of v) {
    if (!Array.isArray(k) || k.length < 2 || !isFiniteNumber(k[0]) || !isFiniteNumber(k[1])) {
      return null;
    }
    const prev = knots[knots.length - 1];
    if (prev && (k[0] <= prev[0] || k[1] <= prev[1])) return null;
    knots.push([k[0], k[1]]);
  }
  return knots;
}

/**
 * The time (epoch s) of work position `w`: linear between knots, and beyond
 * either end along the end segment's slope.
 */
export function clockAt(knots: readonly ClockKnot[], w: number): number {
  let i = 0;
  while (i < knots.length - 2 && w > knots[i + 1][0]) i++;
  const [w0, t0] = knots[i];
  const [w1, t1] = knots[i + 1];
  return t0 + ((w - w0) * (t1 - t0)) / (w1 - w0);
}

/**
 * The marker's `series_queue` block (`v: 2` required) or a file's `live`
 * block (no `v`). Null when it is not an object, or names another version.
 */
export function parseSeriesQueueBlock(
  json: unknown,
  opts: { requireVersion?: boolean } = {}
): SeriesQueueBlock | null {
  if (!isObject(json)) return null;
  if (opts.requireVersion ? json.v !== 2 : json.v !== undefined && json.v !== 2) return null;
  const held =
    isObject(json.held) && typeof json.held.reason === 'string'
      ? { reason: json.held.reason }
      : null;
  const heldRows = Array.isArray(json.held_rows)
    ? json.held_rows.filter((r): r is string => typeof r === 'string')
    : [];
  return {
    held,
    held_rows: heldRows,
    clock: parseClock(json.clock),
    clock_at: isFiniteNumber(json.clock_at) ? json.clock_at : null,
    batch_s: isFiniteNumber(json.batch_s) && json.batch_s > 0 ? json.batch_s : null
  };
}

function readRow(v: unknown): SeriesQueueRow | null {
  if (!isObject(v)) return null;
  const { kind, id } = v;
  if (kind !== 'ocr' && kind !== 'layer') return null;
  if (typeof id !== 'string' || !id) return null;
  const parts = validParts(v.parts);
  return { kind, id, ...(parts ? { parts } : {}) };
}

function readJob(v: unknown, rows: ReadonlyArray<SeriesQueueRow | null>): SeriesQueueJob | null {
  if (!Array.isArray(v)) return null;
  const [row, state] = v;
  if (typeof row !== 'number' || !Number.isInteger(row) || !rows[row]) return null;
  if (state === 'q') {
    const w = v[2];
    if (w !== null && w !== undefined && !isFiniteNumber(w)) return null;
    return { row, state, w: isFiniteNumber(w) ? w : null };
  }
  if (state === 'c') return { row, state };
  if (state === 'r') {
    const [, , t0, e] = v;
    if (!isFiniteNumber(t0)) return null;
    if (e !== null && e !== undefined && !isFiniteNumber(e)) return null;
    return { row, state, t0, e: isFiniteNumber(e) ? e : null };
  }
  return null;
}

/**
 * Validate a series file. `v` must be exactly 2; unknown fields are ignored at
 * every level; a malformed row, job or `done` entry is dropped on its own, and
 * a volume left with no job is left out. Two stems that fold together keep
 * the first.
 */
export function parseSeriesQueueFile(json: unknown): SeriesQueueFile | null {
  if (!isObject(json) || json.v !== 2) return null;
  const { instance_id, rev } = json;
  if (typeof instance_id !== 'string' || !instance_id) return null;
  if (!isFiniteNumber(rev)) return null;
  const rows = Array.isArray(json.rows) ? json.rows.map(readRow) : [];
  const vols = new Map<string, SeriesQueueJob[]>();
  const folded = new Set<string>();
  if (isObject(json.vols)) {
    for (const [stem, list] of Object.entries(json.vols)) {
      const key = normalizeVolumeTitleKey(stem);
      if (!key || folded.has(key) || !Array.isArray(list)) continue;
      const jobs = list.map((j) => readJob(j, rows)).filter((j): j is SeriesQueueJob => j !== null);
      if (jobs.length === 0) continue;
      folded.add(key);
      vols.set(stem, jobs);
    }
  }
  const done = new Map<string, number>();
  if (isObject(json.done)) {
    for (const [stem, at] of Object.entries(json.done)) {
      if (isFiniteNumber(at)) done.set(stem, at);
    }
  }
  return {
    v: 2,
    instance_id,
    rev,
    at: isFiniteNumber(json.at) ? json.at : 0,
    clock_at: isFiniteNumber(json.clock_at) ? json.clock_at : 0,
    series: typeof json.series === 'string' ? json.series : '',
    rows,
    vols,
    done,
    live: json.live === undefined ? null : parseSeriesQueueBlock(json.live)
  };
}

// ---------------------------------------------------------------- trust

/**
 * Which copy counts. Over Bunko's own WebDAV (`live`) the virtual file is
 * Bunko's answer and is trusted as is. Anywhere else (a stored copy) only a
 * file written by the lease holder counts: `instance_id` must name it. Among
 * the copies that count the highest `rev` wins; a stored copy's `live` is
 * ignored (it never carries one, so one that does is no Bunko's).
 */
export type SeriesQueueTrust = { kind: 'live' } | { kind: 'holder'; instanceId: string };

export function pickTrustedCopy(
  files: readonly SeriesQueueFile[],
  trust: SeriesQueueTrust
): SeriesQueueFile | null {
  let best: SeriesQueueFile | null = null;
  for (const file of files) {
    if (trust.kind === 'live' ? !file.live : file.instance_id !== trust.instanceId) continue;
    if (!best || file.rev > best.rev) best = file;
  }
  if (best && trust.kind === 'holder' && best.live) return { ...best, live: null };
  return best;
}

// ---------------------------------------------------------------- the slice

const iso = (s: number) => new Date(s * 1000).toISOString();

/**
 * What the series' volume cards show: folded volume key
 * (`normalizeVolumeTitleKey(stem)`) → its jobs, rendered under `block` (the
 * library-wide hold, held rows and work clock). A global hold shows every job
 * held with its reason; a held row's jobs show "held"; a queued job's ETA is
 * `clock(w)`; a claim is "starting"; a running job carries its start, so the
 * card derives progress from the clock it redraws with.
 */
export function seriesQueueSlice(
  file: SeriesQueueFile,
  block: SeriesQueueBlock | null
): Map<string, VolumeQueueStatus> {
  const held = block?.held ?? null;
  const heldRows = new Set(block?.held_rows ?? []);
  const clock = block?.clock ?? null;
  const slice = new Map<string, VolumeQueueStatus>();
  for (const [stem, jobs] of file.vols) {
    const out: QueueJob[] = [];
    for (const job of jobs) {
      const row = file.rows[job.row]!;
      const base = { kind: row.kind, id: row.id, ...(row.parts ? { parts: row.parts } : {}) };
      if (held || heldRows.has(row.id)) {
        out.push({ ...base, state: 'held', eta: null, progress: null });
      } else if (job.state === 'q') {
        const eta = job.w !== null && clock ? iso(clockAt(clock, job.w)) : null;
        out.push({ ...base, state: 'queued', eta, progress: null });
      } else if (job.state === 'c') {
        out.push({ ...base, state: 'starting', eta: null, progress: null });
      } else {
        out.push({
          ...base,
          state: 'running',
          eta: job.e !== null ? iso(job.e) : null,
          progress: null,
          startedAt: iso(job.t0)
        });
      }
    }
    slice.set(normalizeVolumeTitleKey(stem), { jobs: out, held });
  }
  return slice;
}

// ---------------------------------------------------------------- completions

function jobIdentities(file: SeriesQueueFile, stem: string): Set<string> {
  const out = new Set<string>();
  for (const job of file.vols.get(stem) ?? []) {
    const row = file.rows[job.row];
    if (row) out.add(`${row.kind}:${row.id}`);
  }
  return out;
}

/**
 * The stems whose OCR finished since the previous read (spec §8.6): a job seen
 * in `previous` is gone from `next`, or `next.done` has an entry newer than
 * `sinceS` (the previous read, epoch s). On a first read (`previous` null)
 * there is nothing to compare: a `done` entry counts only for a stem in
 * `watched` (folded keys) — what finished before this device looked is in
 * the listing it loaded. `next` null: the file is gone (nothing owed).
 */
export function seriesCompletions(
  previous: SeriesQueueFile | null,
  next: SeriesQueueFile | null,
  opts: { sinceS: number | null; watched?: ReadonlySet<string> }
): string[] {
  const out = new Map<string, string>();
  const add = (stem: string) => {
    const key = normalizeVolumeTitleKey(stem);
    if (!out.has(key)) out.set(key, stem);
  };
  if (previous) {
    const nextByKey = new Map<string, string>();
    for (const stem of next?.vols.keys() ?? []) nextByKey.set(normalizeVolumeTitleKey(stem), stem);
    for (const stem of previous.vols.keys()) {
      const now = nextByKey.get(normalizeVolumeTitleKey(stem));
      const left = now === undefined ? new Set<string>() : jobIdentities(next!, now);
      for (const id of jobIdentities(previous, stem)) {
        if (!left.has(id)) {
          add(stem);
          break;
        }
      }
    }
  }
  for (const [stem, at] of next?.done ?? []) {
    const seenBefore = previous?.done.get(stem) === at;
    if (seenBefore) continue;
    if (
      previous
        ? opts.sinceS === null || at > opts.sinceS
        : !!opts.watched?.has(normalizeVolumeTitleKey(stem))
    ) {
      add(stem);
    }
  }
  return [...out.values()];
}

/** A stable text of a slice, for "did anything the cards show change". */
export function sliceSignature(slice: ReadonlyMap<string, VolumeQueueStatus>): string {
  return JSON.stringify([...slice]);
}
