import { legacyDeviceFor } from './paths';
import type { EventPayload, Layout, Orientation, ReadingEvent } from './types';

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
 *
 * A new event kind or field is a new `format`; a reader refuses formats it does
 * not know (the importer keeps the old stamp, so an updated app retries).
 */
export const HISTORY_SEGMENT_FORMAT = 1;

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
  const volumes: string[] = [];
  const volIndex = new Map<string, number>();
  const vol = (v: string) => {
    let i = volIndex.get(v);
    if (i === undefined) {
      i = volumes.length;
      volumes.push(v);
      volIndex.set(v, i);
    }
    return i;
  };

  let prevSeq = 0;
  let prevT = 0;
  let prevDevice = '';
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
    }
  });

  const header: SegmentHeader = {
    format: HISTORY_SEGMENT_FORMAT,
    device,
    month,
    first_seq: legacy ? 0 : (sorted[0]?.seq ?? 0),
    last_seq: legacy ? 0 : (sorted.at(-1)?.seq ?? 0),
    count: sorted.length,
    ...(legacy && { legacy: true as const })
  };
  const json = JSON.stringify({ ...header, volumes, rows });
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
  if (parsed.format !== HISTORY_SEGMENT_FORMAT) {
    throw new SegmentFormatError(`unsupported segment format ${parsed.format}`);
  }
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
