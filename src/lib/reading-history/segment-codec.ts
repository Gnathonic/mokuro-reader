import { legacyDeviceFor } from './paths';
import type {
  CreditPayload,
  EventPayload,
  Layout,
  Orientation,
  PauseCount,
  PositionPayload,
  ReadingEvent
} from './types';

/**
 * One month of one device's events, as stored in the cloud (spec: Storage →
 * Cloud). Deflated JSON: a header, a volume dictionary, then one compact row
 * per event with `seq` and `t` delta-encoded against the previous row. Rows
 * repeat the same shapes, so deflate does the rest.
 *
 * Row layouts (first cell = kind code):
 *   0 page    [0, dSeq, dT, vol, first, last, page_chars[], chars_before, dwell|-1, layout, orientation, w|-1, h|-1]
 *   1 adjust  [1, dSeq, dT, vol, time_delta_ms, chars_delta]
 *   2 restart [2, dSeq, dT, vol]
 *   3 forget  [3, dSeq, dT, vol, before]
 *   4 position [4, dSeq, dT, vol, answer (0 jump, 1 stay, 2 reset), through, page]
 *   5 resolve [5, dSeq, dT, vol, target device, target seq, count (0 full, 1 typical, 2 none)]
 *   6 credit  [6, dSeq, dT, vol, time_ms, runs[], page_chars[]]      (format 2 only)
 *   7 retract [7, dSeq, dT, vol, target device, target seq]          (format 2 only)
 *
 * `target device` indexes a second dictionary, `targets`, written only when
 * the segment holds a resolve or a retract (so a segment without one keeps
 * its bytes). Resolves, credits and retracts live in month segments only: a
 * legacy device never answers, credits or retracts. A credit's `runs` are
 * `[first, last, …]` pairs of its (ascending) pages, so consecutive pages
 * collapse into one pair; `page_chars` lists every page's characters in order.
 *
 * A new event kind or field AFTER a release is a new `format`; a reader refuses
 * formats it does not know (the importer keeps the old stamp, so an updated app
 * retries). Format 1 was settled before any release read segments, `position`
 * (kind 4) and `resolve` (kind 5) included. Format 2 adds `credit` and
 * `retract` (#224) and is written ONLY for a segment that holds one of them:
 * every other segment stays format 1, byte for byte, so an app that knows
 * only format 1 misses nothing but the device-months that hold a credit, and
 * picks those up once it updates.
 */
export const HISTORY_SEGMENT_FORMAT = 1;
/** The format of a segment that holds a `credit` or `retract` row. */
export const CREDIT_SEGMENT_FORMAT = 2;
const READABLE_FORMATS: readonly number[] = [HISTORY_SEGMENT_FORMAT, CREDIT_SEGMENT_FORMAT];

export interface SegmentHeader {
  format: number;
  device: string;
  month: string;
  first_seq: number;
  last_seq: number;
  count: number;
  /**
   * A legacy segment (`legacy.events`): `device` is the uploader, and each
   * event belongs to `legacy:<its volume>` — converted page turns, keyed so that
   * every device converting the same turns produces the same events.
   */
  legacy?: true;
}

export class SegmentFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentFormatError';
  }
}

const LAYOUTS: Array<Layout | 'unknown'> = [
  'single',
  'double',
  'continuous-v',
  'continuous-h',
  'unknown'
];
const ORIENTATIONS: Array<Orientation | 'unknown'> = ['portrait', 'landscape', 'unknown'];
const ANSWERS: Array<PositionPayload['answer']> = ['jump', 'stay', 'reset'];
const COUNTS: PauseCount[] = ['full', 'typical', 'none'];

type Row = Array<number | number[]>;

export async function encodeSegment(
  device: string,
  month: string,
  events: ReadingEvent[],
  options: { legacy?: boolean } = {}
): Promise<Uint8Array> {
  const legacy = options.legacy === true;
  // Legacy rows run per legacy device (volume), seqs increasing within each.
  const sorted = [...events].sort((a, b) =>
    legacy ? a.device.localeCompare(b.device) || a.seq - b.seq : a.seq - b.seq
  );
  const volumes = dictionary();
  const targets = dictionary();
  const vol = volumes.index;

  let prevSeq = 0;
  let prevT = 0;
  let prevDevice = '';
  /** A credit or retract row makes this a format-2 segment. */
  let credits = false;
  const rows: Row[] = sorted.map((e) => {
    const owner = legacy ? legacyDeviceFor(e.volume) : device;
    if (e.device !== owner) {
      throw new SegmentFormatError(
        `event of ${e.device} in ${legacy ? 'a legacy' : `${device}'s`} segment`
      );
    }
    if (prevDevice !== e.device) prevSeq = 0;
    prevDevice = e.device;
    const head = [e.seq - prevSeq, e.t - prevT];
    prevSeq = e.seq;
    prevT = e.t;
    switch (e.kind) {
      case 'page':
        return [
          0,
          ...head,
          vol(e.volume),
          e.first_page,
          e.last_page,
          e.page_chars,
          e.chars_before,
          e.dwell_ms ?? -1,
          LAYOUTS.indexOf(e.layout),
          ORIENTATIONS.indexOf(e.orientation),
          e.viewport?.w ?? -1,
          e.viewport?.h ?? -1
        ];
      case 'adjust':
        return [1, ...head, vol(e.volume), e.time_delta_ms, e.chars_delta];
      case 'restart':
        return [2, ...head, vol(e.volume)];
      case 'forget':
        return [3, ...head, vol(e.volume), e.before];
      case 'position':
        return [4, ...head, vol(e.volume), ANSWERS.indexOf(e.answer), e.through, e.page];
      case 'resolve':
        return [
          5,
          ...head,
          vol(e.volume),
          targets.index(e.target[0]),
          e.target[1],
          COUNTS.indexOf(e.count)
        ];
      case 'credit':
        credits = true;
        return [6, ...head, vol(e.volume), e.time_ms, creditRuns(e), [...e.page_chars]];
      case 'retract':
        credits = true;
        return [7, ...head, vol(e.volume), targets.index(e.target[0]), e.target[1]];
    }
  });

  const header: SegmentHeader = {
    format: credits ? CREDIT_SEGMENT_FORMAT : HISTORY_SEGMENT_FORMAT,
    device,
    month,
    first_seq: legacy ? 0 : (sorted[0]?.seq ?? 0),
    last_seq: legacy ? 0 : (sorted.at(-1)?.seq ?? 0),
    count: sorted.length,
    ...(legacy && { legacy: true as const })
  };
  const json = JSON.stringify({
    ...header,
    volumes: volumes.values,
    ...(targets.values.length > 0 && { targets: targets.values }),
    rows
  });
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeSegment(
  bytes: Uint8Array
): Promise<{ header: SegmentHeader; events: ReadingEvent[] }> {
  let parsed: any;
  try {
    // Copied into an ArrayBuffer-backed view: the DOM types refuse a view that
    // may sit on a SharedArrayBuffer as a BlobPart.
    const stream = new Blob([new Uint8Array(bytes)])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    parsed = JSON.parse(await new Response(stream).text());
  } catch (error) {
    throw new SegmentFormatError(`unreadable segment: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new SegmentFormatError('not a segment');
  if (!READABLE_FORMATS.includes(parsed.format)) {
    throw new SegmentFormatError(`unsupported segment format ${parsed.format}`);
  }
  const format2 = parsed.format === CREDIT_SEGMENT_FORMAT;
  const { device, month, first_seq, last_seq, count, volumes, rows } = parsed;
  if (
    typeof device !== 'string' ||
    typeof month !== 'string' ||
    !Array.isArray(volumes) ||
    !Array.isArray(rows) ||
    rows.length !== count ||
    !Number.isSafeInteger(first_seq) ||
    !Number.isSafeInteger(last_seq)
  ) {
    throw new SegmentFormatError('malformed segment header');
  }

  const targets: string[] = parsed.targets === undefined ? [] : parsed.targets;
  if (!Array.isArray(targets) || targets.some((d) => typeof d !== 'string')) {
    throw new SegmentFormatError('malformed segment header');
  }

  const legacy = parsed.legacy === true;
  let seq = 0;
  let t = 0;
  let rowDevice = '';
  const finished = new Set<string>();
  const events = rows.map((row: any[]): ReadingEvent => {
    if (!Array.isArray(row)) throw new SegmentFormatError('malformed row');
    // Every cell is checked: a file that decodes is still untrusted, and a
    // malformed cell would otherwise become a garbage event or an invalid
    // IndexedDB key that aborts the import on every sync.
    const volume = volumes[row[3]];
    if (typeof volume !== 'string') throw new SegmentFormatError('unknown volume index');
    const eventDevice = legacy ? legacyDeviceFor(volume) : device;
    if (eventDevice !== rowDevice) {
      // Each device's rows are contiguous (seqs restart per device), so a
      // device that comes back would repeat keys.
      if (finished.has(eventDevice)) throw new SegmentFormatError('device rows are not contiguous');
      if (rowDevice) finished.add(rowDevice);
      rowDevice = eventDevice;
      seq = 0;
    }
    const dSeq = int(row[1]);
    if (dSeq <= 0) throw new SegmentFormatError('seq must strictly increase');
    seq += dSeq;
    t += int(row[2]);
    let payload: EventPayload;
    switch (row[0]) {
      case 0:
        payload = {
          kind: 'page',
          volume,
          first_page: int(row[4]),
          last_page: int(row[5]),
          page_chars: numbers(row[6]),
          chars_before: num(row[7]),
          dwell_ms: row[8] === -1 ? null : num(row[8]),
          layout: LAYOUTS[row[9]] ?? 'unknown',
          orientation: ORIENTATIONS[row[10]] ?? 'unknown',
          viewport: row[11] === -1 ? null : { w: num(row[11]), h: num(row[12]) }
        };
        break;
      case 1:
        payload = { kind: 'adjust', volume, time_delta_ms: num(row[4]), chars_delta: num(row[5]) };
        break;
      case 2:
        payload = { kind: 'restart', volume };
        break;
      case 3:
        payload = { kind: 'forget', volume, before: num(row[4]) };
        break;
      case 4: {
        const answer = ANSWERS[int(row[4])];
        if (!answer) throw new SegmentFormatError('unknown position answer');
        payload = { kind: 'position', volume, answer, through: num(row[5]), page: int(row[6]) };
        break;
      }
      case 5: {
        if (legacy) throw new SegmentFormatError('resolve in a legacy segment');
        const targetDevice = targets[int(row[4])];
        if (!targetDevice) throw new SegmentFormatError('unknown target device');
        const targetSeq = int(row[5]);
        if (targetSeq <= 0) throw new SegmentFormatError('target seq must be positive');
        const count = COUNTS[int(row[6])];
        if (!count) throw new SegmentFormatError('unknown pause answer');
        payload = { kind: 'resolve', volume, target: [targetDevice, targetSeq], count };
        break;
      }
      case 6: {
        if (legacy || !format2) throw new SegmentFormatError('credit outside a format-2 segment');
        const time_ms = num(row[4]);
        if (time_ms < 0) throw new SegmentFormatError('negative credit time');
        const pages = expandRuns(row[5]);
        const page_chars = numbers(row[6]);
        if (page_chars.length !== pages.length || page_chars.some((c) => c < 0)) {
          throw new SegmentFormatError('credit page chars do not match its pages');
        }
        payload = { kind: 'credit', volume, pages, page_chars, time_ms };
        break;
      }
      case 7: {
        if (legacy || !format2) throw new SegmentFormatError('retract outside a format-2 segment');
        const targetDevice = targets[int(row[4])];
        if (!targetDevice) throw new SegmentFormatError('unknown target device');
        const targetSeq = int(row[5]);
        if (targetSeq <= 0) throw new SegmentFormatError('target seq must be positive');
        payload = { kind: 'retract', volume, target: [targetDevice, targetSeq] };
        break;
      }
      default:
        throw new SegmentFormatError(`unknown event kind ${row[0]}`);
    }
    return { device: eventDevice, seq, t, ...payload } as ReadingEvent;
  });

  if (
    !legacy &&
    events.length > 0 &&
    (events[0].seq !== first_seq || events.at(-1)!.seq !== last_seq)
  ) {
    throw new SegmentFormatError('seq range does not match header');
  }
  const header: SegmentHeader = {
    format: parsed.format,
    device,
    month,
    first_seq,
    last_seq,
    count,
    ...(legacy && { legacy: true as const })
  };
  return { header, events };
}

/** The longest run of pages a credit row may hold (`last - first` stays under it). */
export const MAX_CREDIT_RUN = 100_000;

/**
 * A credit's pages as `[first, last, …]` runs, refusing any credit the decoder
 * would not give back: pages whole, positive, strictly ascending and in runs
 * shorter than `MAX_CREDIT_RUN`; one finite, non-negative character count per
 * page; a finite, non-negative time. Every other device refuses a whole
 * device-month over one bad row, permanently (events are never edited), so
 * `appendEvent` runs this before a credit is stored and the encoder again.
 */
export function creditRuns(
  credit: Pick<CreditPayload, 'pages' | 'page_chars' | 'time_ms'>
): number[] {
  const { pages, page_chars, time_ms } = credit;
  if (!Number.isFinite(time_ms) || time_ms < 0) {
    throw new SegmentFormatError('credit time must be finite and non-negative');
  }
  if (page_chars.length !== pages.length || page_chars.some((c) => !Number.isFinite(c) || c < 0)) {
    throw new SegmentFormatError('credit page chars do not match its pages');
  }
  if (pages.length === 0) throw new SegmentFormatError('a credit with no pages');
  const runs: number[] = [];
  let previous = 0;
  for (const page of pages) {
    if (!Number.isSafeInteger(page) || page <= previous) {
      throw new SegmentFormatError('credit pages must be positive and strictly ascending');
    }
    if (runs.length > 0 && page === previous + 1) runs[runs.length - 1] = page;
    else runs.push(page, page);
    if (runs[runs.length - 1] - runs[runs.length - 2] >= MAX_CREDIT_RUN) {
      throw new SegmentFormatError('credit run longer than any volume');
    }
    previous = page;
  }
  return runs;
}

/** `pageRuns` back into pages, refusing anything `pageRuns` would not write. */
function expandRuns(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length % 2 !== 0) {
    throw new SegmentFormatError('malformed credit runs');
  }
  const pages: number[] = [];
  let previous = 0;
  for (let i = 0; i < value.length; i += 2) {
    const first = int(value[i]);
    const last = int(value[i + 1]);
    // Adjacent runs would have been one: `first` must leave a gap.
    if (first <= previous + (i > 0 ? 1 : 0) || last < first) {
      throw new SegmentFormatError('malformed credit runs');
    }
    // A run longer than any volume is a hostile file, not a credit.
    if (last - first >= MAX_CREDIT_RUN) throw new SegmentFormatError('malformed credit runs');
    for (let page = first; page <= last; page++) pages.push(page);
    previous = last;
  }
  return pages;
}

/** A string table for a segment's header: each distinct value once, rows hold its index. */
function dictionary(): { values: string[]; index: (value: string) => number } {
  const values: string[] = [];
  const indices = new Map<string, number>();
  return {
    values,
    index(value) {
      let i = indices.get(value);
      if (i === undefined) {
        i = values.length;
        values.push(value);
        indices.set(value, i);
      }
      return i;
    }
  };
}

function num(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SegmentFormatError('malformed number cell');
  }
  return value;
}

function int(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new SegmentFormatError('malformed integer cell');
  return value as number;
}

function numbers(value: unknown): number[] {
  if (!Array.isArray(value)) throw new SegmentFormatError('malformed list cell');
  return value.map(num);
}
