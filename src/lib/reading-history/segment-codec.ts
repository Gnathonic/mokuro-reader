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
  events: ReadingEvent[]
): Promise<Uint8Array> {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
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
  const rows: Row[] = sorted.map((e) => {
    if (e.device !== device)
      throw new SegmentFormatError(`event of ${e.device} in ${device}'s segment`);
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
    first_seq: sorted[0]?.seq ?? 0,
    last_seq: sorted.at(-1)?.seq ?? 0,
    count: sorted.length
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
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
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
    rows.length !== count
  ) {
    throw new SegmentFormatError('malformed segment header');
  }

  let seq = 0;
  let t = 0;
  const events = rows.map((row: any[]): ReadingEvent => {
    if (!Array.isArray(row)) throw new SegmentFormatError('malformed row');
    seq += row[1];
    t += row[2];
    const volume = volumes[row[3]];
    if (typeof volume !== 'string') throw new SegmentFormatError('unknown volume index');
    let payload: EventPayload;
    switch (row[0]) {
      case 0:
        payload = {
          kind: 'page',
          volume,
          first_page: row[4],
          last_page: row[5],
          page_chars: row[6],
          chars_before: row[7],
          dwell_ms: row[8] === -1 ? null : row[8],
          layout: LAYOUTS[row[9]] ?? 'unknown',
          orientation: ORIENTATIONS[row[10]] ?? 'unknown',
          viewport: row[11] === -1 ? null : { w: row[11], h: row[12] }
        };
        break;
      case 1:
        payload = { kind: 'adjust', volume, time_delta_ms: row[4], chars_delta: row[5] };
        break;
      case 2:
        payload = { kind: 'restart', volume };
        break;
      case 3:
        payload = { kind: 'forget', volume, before: row[4] };
        break;
      default:
        throw new SegmentFormatError(`unknown event kind ${row[0]}`);
    }
    return { device, seq, t, ...payload } as ReadingEvent;
  });

  if (events.length > 0 && (events[0].seq !== first_seq || events.at(-1)!.seq !== last_seq)) {
    throw new SegmentFormatError('seq range does not match header');
  }
  return { header: { format: parsed.format, device, month, first_seq, last_seq, count }, events };
}
