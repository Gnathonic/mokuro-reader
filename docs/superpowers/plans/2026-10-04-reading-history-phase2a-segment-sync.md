# Reading History Phase 2a — Segment Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every device uploads its own reading events as monthly files under `history/<device>/` and imports every other device's, so each device's `mokuro_history` database holds the union of all devices' events.

**Architecture:** Pure modules in `src/lib/reading-history/` (path rules, a versioned deflated segment codec, the sync pass) plus the provider listing fixes that make three-segment `history/<device>/<file>` paths visible on every backend. The pass runs at the end of `syncProvider`, best-effort (never fails a sync), lazily imported (keeps Dexie out of suites that mock it). Page turns are still written; nothing reads the imported events yet (phase 2b/3).

**Tech Stack:** SvelteKit 5, Dexie 4 (`mokuro_history`), `CompressionStream('deflate-raw')`, Vitest + jsdom + fake-indexeddb, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md` (sections Storage → Cloud, Import, Integrity rules; Migration → mokuro-bunko).

## Global Constraints

- A device only ever writes files under its own `history/<device>/` folder; it never uploads events whose `device` isn't its own.
- Size or modified time only decides whether to download; it never decides what gets written locally.
- Import is idempotent: events keyed by `[device, seq]`; re-imports, retries and duplicate downloads are no-ops.
- A file that fails to decode never runs its transaction and leaves the old stamp, so it is retried next listing.
- History uploads are skipped on mokuro-bunko (`serverCompilesMetadata`) until a bunko release treats `history/` as per-user; read-only providers skip uploads too. Imports still run.
- A history upload failure must never demote a provider to read-only, clear credentials, or fail the sync.
- File format: small header (`format`, `device`, `month`, `first_seq`, `last_seq`, `count`) + delta-encoded rows, deflated with the built-in `CompressionStream`. No new dependency.
- Months are UTC `YYYY-MM` of the event's `t`.
- Never mention the third-party public deployment domain in code, comments, commits or PRs.

## Review Focus

1. Truncated/corrupt segment bytes → nothing imported, stamp untouched, retried next listing (Task 5 test).
2. The same segment listed twice (Drive duplicate files) or imported twice → identical table, no duplicates (Task 5 test).
3. An event at 23:59:59.999 UTC on the last day of a month lands in that month's file, whatever the local timezone (Task 1 test).
4. Switching provider → every month is uploaded again to the new provider (upload marks are per provider) (Task 5 test).
5. A month upload that throws → its mark is not written; the next sync retries it; other months still go up (Task 5 test).

---

### Task 1: History paths and the allowlist

**Files:**
- Create: `src/lib/reading-history/paths.ts`
- Test: `src/lib/reading-history/paths.test.ts`
- Modify: `src/lib/util/sync/syncable-file.ts` (`isSyncableFile`, `isBestEffortMetadataPath` + doc)
- Test: `src/lib/util/sync/syncable-file.test.ts`

**Interfaces:**
- Produces:
  - `HISTORY_FOLDER = 'history'`, `DEVICE_FILE_NAME = 'device.json'`
  - `historyMonthOf(t: number): string` (UTC `YYYY-MM`)
  - `historySegmentPath(device: string, month: string): string`
  - `historyDeviceFilePath(device: string): string`
  - `type HistoryPath = { device: string; kind: 'month'; month: string } | { device: string; kind: 'device' }`
  - `parseHistoryPath(path: string): HistoryPath | null`
  - `isHistoryFilePath(path: string): boolean`
  - `isHistoryFileName(name: string): boolean` (basename prefilter for Drive/MEGA)

- [ ] **Step 1: Write the failing tests** — `paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  historyDeviceFilePath,
  historyMonthOf,
  historySegmentPath,
  isHistoryFileName,
  isHistoryFilePath,
  parseHistoryPath
} from './paths';

const DEV = '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';

describe('history paths', () => {
  it('months are UTC, including the last millisecond of a month', () => {
    expect(historyMonthOf(Date.UTC(2026, 9, 31, 23, 59, 59, 999))).toBe('2026-10');
    expect(historyMonthOf(Date.UTC(2026, 10, 1, 0, 0, 0, 0))).toBe('2026-11');
    expect(historyMonthOf(Date.UTC(2027, 0, 5))).toBe('2027-01');
  });

  it('builds and parses segment and device paths', () => {
    expect(historySegmentPath(DEV, '2026-10')).toBe(`history/${DEV}/2026-10.events`);
    expect(historyDeviceFilePath(DEV)).toBe(`history/${DEV}/device.json`);
    expect(parseHistoryPath(`history/${DEV}/2026-10.events`)).toEqual({
      device: DEV,
      kind: 'month',
      month: '2026-10'
    });
    expect(parseHistoryPath(`history/${DEV}/device.json`)).toEqual({ device: DEV, kind: 'device' });
  });

  it.each([
    'history/2026-10.events',
    `history/${DEV}/sub/2026-10.events`,
    `History/${DEV}/2026-10.events`,
    `history/${DEV}/2026-13.events`,
    `history/${DEV}/2026-1.events`,
    `history/${DEV}/notes.json`,
    `history/bad id!/2026-10.events`,
    `Series/${DEV}/2026-10.events`,
    `history/${DEV}/2026-10.events.bak`
  ])('rejects %s', (path) => {
    expect(parseHistoryPath(path)).toBeNull();
    expect(isHistoryFilePath(path)).toBe(false);
  });

  it('recognises history basenames for listing prefilters', () => {
    expect(isHistoryFileName('2026-10.events')).toBe(true);
    expect(isHistoryFileName('device.json')).toBe(true);
    expect(isHistoryFileName('volume-data.json')).toBe(false);
  });
});
```

Add to `syncable-file.test.ts`:

```ts
import { isBestEffortMetadataPath, isSyncableFile } from './syncable-file';

describe('history files', () => {
  const DEV = '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';
  it('lists history segments and device facts by full path', () => {
    expect(isSyncableFile(`history/${DEV}/2026-10.events`)).toBe(true);
    expect(isSyncableFile(`history/${DEV}/device.json`)).toBe(true);
  });
  it('does not list a device.json or .events anywhere else', () => {
    expect(isSyncableFile('device.json')).toBe(false);
    expect(isSyncableFile('Series/device.json')).toBe(false);
    expect(isSyncableFile('Series/2026-10.events')).toBe(false);
  });
  it('treats history writes as best-effort', () => {
    expect(isBestEffortMetadataPath(`history/${DEV}/2026-10.events`)).toBe(true);
    expect(isBestEffortMetadataPath('volume-data.json')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/reading-history/paths.test.ts src/lib/util/sync/syncable-file.test.ts` → FAIL (module missing / false).

- [ ] **Step 3: Implement** — `paths.ts`:

```ts
/**
 * Where reading history lives in the cloud (spec: Storage → Cloud):
 *
 *   history/<device>/device.json        that device's facts
 *   history/<device>/<YYYY-MM>.events   one UTC month of that device's events
 *
 * Exactly three segments, case-sensitive. Anything else is not ours.
 */
export const HISTORY_FOLDER = 'history';
export const DEVICE_FILE_NAME = 'device.json';

const MONTH_FILE_RE = /^(\d{4})-(0[1-9]|1[0-2])\.events$/;
const DEVICE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export type HistoryPath =
  | { device: string; kind: 'month'; month: string }
  | { device: string; kind: 'device' };

/** UTC `YYYY-MM`: the same month on every device, whatever its timezone. */
export function historyMonthOf(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function historySegmentPath(device: string, month: string): string {
  return `${HISTORY_FOLDER}/${device}/${month}.events`;
}

export function historyDeviceFilePath(device: string): string {
  return `${HISTORY_FOLDER}/${device}/${DEVICE_FILE_NAME}`;
}

export function parseHistoryPath(path: string): HistoryPath | null {
  const parts = path.split('/');
  if (parts.length !== 3 || parts[0] !== HISTORY_FOLDER) return null;
  const [, device, name] = parts;
  if (!DEVICE_ID_RE.test(device)) return null;
  if (name === DEVICE_FILE_NAME) return { device, kind: 'device' };
  const match = MONTH_FILE_RE.exec(name);
  return match ? { device, kind: 'month', month: `${match[1]}-${match[2]}` } : null;
}

export function isHistoryFilePath(path: string): boolean {
  return parseHistoryPath(path) !== null;
}

/** Basename prefilter for listings that see names before paths (Drive, MEGA). */
export function isHistoryFileName(name: string): boolean {
  return name === DEVICE_FILE_NAME || MONTH_FILE_RE.test(name);
}
```

`syncable-file.ts`: import `isHistoryFilePath` from `$lib/reading-history/paths`; `isSyncableFile(path)` returns `isCbzFile(b) || isSidecarFile(b) || isRootConfigFile(b) || isHistoryFilePath(path)`; `isBestEffortMetadataPath(path)` returns `isSeriesFilePath(path) || isCatalogFilePath(path) || isHistoryFilePath(path)`, and its doc comment gains: "History segments (`history/<device>/…`) too: they are this device's copy of data it keeps locally, re-uploaded on the next sync; a rejection (bunko before it maps `history/` per-user, a read-only share) must not demote the provider." Before editing, `grep -rn isBestEffortMetadataPath src --include=*.ts` and confirm every caller only uses it to suppress demotion/UI (expected: webdav-provider upload + delete, unified-cloud-manager). If a caller uses it to mean "compiled by the server", add a separate `isBestEffortWritePath` instead and use it at the WebDAV write sites; record the ruling.

- [ ] **Step 4: Run** the two test files → PASS.
- [ ] **Step 5: Commit** — `git add src/lib/reading-history/paths.ts src/lib/reading-history/paths.test.ts src/lib/util/sync/syncable-file.ts src/lib/util/sync/syncable-file.test.ts && git commit -m "feat(history): cloud paths for history segments; list them on every provider"`

---

### Task 2: Segment codec

**Files:**
- Create: `src/lib/reading-history/segment-codec.ts`
- Test: `src/lib/reading-history/segment-codec.test.ts`

**Interfaces:**
- Consumes: `ReadingEvent`, `PagePayload`, `Layout`, `Orientation` from `./types`
- Produces:
  - `HISTORY_SEGMENT_FORMAT = 1`
  - `interface SegmentHeader { format: number; device: string; month: string; first_seq: number; last_seq: number; count: number }`
  - `class SegmentFormatError extends Error`
  - `encodeSegment(device: string, month: string, events: ReadingEvent[]): Promise<Uint8Array>`
  - `decodeSegment(bytes: Uint8Array): Promise<{ header: SegmentHeader; events: ReadingEvent[] }>`

- [ ] **Step 1: Failing tests**:

```ts
import { describe, expect, it } from 'vitest';
import { decodeSegment, encodeSegment, SegmentFormatError } from './segment-codec';
import type { ReadingEvent } from './types';

const DEV = 'dev-a';
const T = Date.UTC(2026, 9, 3, 12);
const events: ReadingEvent[] = [
  {
    device: DEV, seq: 4, t: T, kind: 'page', volume: 'vol-1', first_page: 3, last_page: 4,
    page_chars: [120, 0], chars_before: 300, dwell_ms: 41000, layout: 'double',
    orientation: 'landscape', viewport: { w: 1920, h: 1080 }
  },
  {
    device: DEV, seq: 5, t: T + 41000, kind: 'page', volume: 'vol-1', first_page: 5, last_page: 5,
    page_chars: [88], chars_before: 420, dwell_ms: null, layout: 'unknown',
    orientation: 'unknown', viewport: null
  },
  { device: DEV, seq: 6, t: T + 60000, kind: 'adjust', volume: 'vol-2', time_delta_ms: -60000, chars_delta: 0 },
  { device: DEV, seq: 9, t: T + 61000, kind: 'restart', volume: 'vol-2' },
  { device: DEV, seq: 10, t: T + 62000, kind: 'forget', volume: 'vol-1', before: T + 62000 }
];

describe('segment codec', () => {
  it('round-trips every event kind exactly, in seq order', async () => {
    const bytes = await encodeSegment(DEV, '2026-10', [...events].reverse());
    const { header, events: out } = await decodeSegment(bytes);
    expect(header).toEqual({ format: 1, device: DEV, month: '2026-10', first_seq: 4, last_seq: 10, count: 5 });
    expect(out).toEqual(events);
  });

  it('is much smaller than the JSON it replaces', async () => {
    const many: ReadingEvent[] = Array.from({ length: 500 }, (_, i) => ({
      ...(events[0] as Extract<ReadingEvent, { kind: 'page' }>),
      seq: i + 1, t: T + i * 30000, first_page: i + 1, last_page: i + 1,
      page_chars: [100 + (i % 7)], chars_before: i * 100
    }));
    const bytes = await encodeSegment(DEV, '2026-10', many);
    expect(bytes.length * 5).toBeLessThan(JSON.stringify(many).length);
  });

  it('refuses events from another device', async () => {
    await expect(encodeSegment('dev-b', '2026-10', events)).rejects.toThrow(SegmentFormatError);
  });

  it.each([
    ['garbage', new Uint8Array([1, 2, 3, 4])],
    ['empty', new Uint8Array()]
  ])('rejects %s bytes', async (_l, bytes) => {
    await expect(decodeSegment(bytes)).rejects.toThrow(SegmentFormatError);
  });

  it('rejects a truncated file', async () => {
    const bytes = await encodeSegment(DEV, '2026-10', events);
    await expect(decodeSegment(bytes.slice(0, Math.floor(bytes.length / 2)))).rejects.toThrow(
      SegmentFormatError
    );
  });

  it('rejects a newer format it cannot read', async () => {
    const json = JSON.stringify({ format: 2, device: DEV, month: '2026-10', first_seq: 1, last_seq: 1, count: 0, volumes: [], rows: [] });
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    await expect(decodeSegment(bytes)).rejects.toThrow(/format 2/);
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** `segment-codec.ts`:

```ts
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

const LAYOUTS: Array<Layout | 'unknown'> = ['single', 'double', 'continuous-v', 'continuous-h', 'unknown'];
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
    if (e.device !== device) throw new SegmentFormatError(`event of ${e.device} in ${device}'s segment`);
    const head = [e.seq - prevSeq, e.t - prevT];
    prevSeq = e.seq;
    prevT = e.t;
    switch (e.kind) {
      case 'page':
        return [
          0, ...head, vol(e.volume), e.first_page, e.last_page, e.page_chars, e.chars_before,
          e.dwell_ms ?? -1, LAYOUTS.indexOf(e.layout), ORIENTATIONS.indexOf(e.orientation),
          e.viewport?.w ?? -1, e.viewport?.h ?? -1
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
    typeof device !== 'string' || typeof month !== 'string' || !Array.isArray(volumes) ||
    !Array.isArray(rows) || rows.length !== count
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
          kind: 'page', volume, first_page: row[4], last_page: row[5], page_chars: row[6],
          chars_before: row[7], dwell_ms: row[8] === -1 ? null : row[8],
          layout: LAYOUTS[row[9]] ?? 'unknown', orientation: ORIENTATIONS[row[10]] ?? 'unknown',
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
```

Format the file with Prettier after writing (the dense literals above are for the plan).

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git add src/lib/reading-history/segment-codec.* && git commit -m "feat(history): versioned deflated segment codec"`

---

### Task 3: `history_files` table (Dexie version 2)

**Files:**
- Modify: `src/lib/reading-history/history-db.ts`
- Test: `src/lib/reading-history/history-db.test.ts` (create)

**Interfaces:**
- Produces: `interface HistoryFileRecord { path: string; provider: string; size: number; modifiedTime: string; last_seq: number }`; `HistoryDexie.history_files: Table<HistoryFileRecord, string>`.

- [ ] **Step 1: Failing test**:

```ts
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { HistoryDexie } from './history-db';

describe('history db v2', () => {
  it('upgrades a v1 database in place, keeping its events', async () => {
    const name = `upgrade-${Math.random()}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({ reading_events: '[device+seq], volume, t', devices: 'device', history_meta: 'key' });
    await v1.table('reading_events').add({ device: 'd', seq: 1, t: 5, kind: 'restart', volume: 'v' });
    v1.close();

    const db = new HistoryDexie(name);
    expect(await db.reading_events.count()).toBe(1);
    await db.history_files.put({ path: 'history/x/2026-10.events', provider: 'webdav', size: 3, modifiedTime: 'm', last_seq: 9 });
    expect((await db.history_files.get('history/x/2026-10.events'))?.last_seq).toBe(9);
    db.close();
  });
});
```

- [ ] **Step 2: Run** → FAIL (`history_files` undefined).
- [ ] **Step 3: Implement** — add the interface and table, and `this.version(2).stores({ history_files: 'path' });` after version 1 (Dexie carries v1's stores forward; never edit version 1).
- [ ] **Step 4: Run** → PASS; also run `npx vitest run src/lib/reading-history` → all PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(history): history_files table for imported segment stamps"`

---

### Task 4: Provider listings and uploads for nested history paths

**Files:**
- Modify: `src/lib/util/sync/providers/webdav/webdav-provider.ts` (both `isSyncableFile(item.basename)` call sites → relative path)
- Modify: `src/lib/util/sync/providers/mega/mega-provider.ts` (listing prefilter + full-path check)
- Modify: `src/lib/util/sync/providers/onedrive/onedrive-provider.ts` (`ensureSeriesFolder` walks segments)
- Create: `src/lib/util/sync/providers/google-drive/drive-history-path.ts`
- Modify: `src/lib/util/sync/providers/google-drive/drive-files-cache.ts` (history branch in `fetchAllFiles`; `add()` keys by first segment)
- Modify: `src/lib/util/sync/providers/google-drive/google-drive-provider.ts` (history branch in `listCloudVolumes`; `.events` MIME)
- Tests: `drive-history-path.test.ts` (create), `drive-files-cache.test.ts`, `onedrive/__tests__/onedrive-provider.test.ts`, `webdav/webdav-provider.test.ts`, `mega/mega-provider.test.ts`

**Interfaces:**
- Consumes: `isHistoryFileName`, `isHistoryFilePath`, `HISTORY_FOLDER` (Task 1)
- Produces: `driveHistoryPath(file: { name: string; parents?: string[] }, folders: Map<string, { name: string; parent?: string }>, readerFolderName: string): string | null`

- [ ] **Step 1: Failing tests.**

`drive-history-path.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { driveHistoryPath } from './drive-history-path';

const folders = new Map([
  ['reader', { name: 'mokuro-reader' }],
  ['hist', { name: 'history', parent: 'reader' }],
  ['dev', { name: 'dev-a', parent: 'hist' }],
  ['other-hist', { name: 'history', parent: 'elsewhere' }],
  ['dev2', { name: 'dev-a', parent: 'other-hist' }],
  ['series', { name: 'Some Series', parent: 'reader' }]
]);

describe('driveHistoryPath', () => {
  it('walks up to mokuro-reader/history/<device>', () => {
    expect(driveHistoryPath({ name: '2026-10.events', parents: ['dev'] }, folders, 'mokuro-reader')).toBe(
      'history/dev-a/2026-10.events'
    );
  });
  it('rejects a history folder outside mokuro-reader, or a file in a series folder', () => {
    expect(driveHistoryPath({ name: '2026-10.events', parents: ['dev2'] }, folders, 'mokuro-reader')).toBeNull();
    expect(driveHistoryPath({ name: 'device.json', parents: ['series'] }, folders, 'mokuro-reader')).toBeNull();
    expect(driveHistoryPath({ name: '2026-10.events' }, folders, 'mokuro-reader')).toBeNull();
  });
});
```

`drive-files-cache.test.ts` (new `describe`, reuse the file's `driveApiClient.listFiles` mock):

```ts
describe('driveFilesCache history segments', () => {
  beforeEach(() => { vi.clearAllMocks(); driveFilesCache.clear(); });

  it('caches history/<device>/<file> at its full path, and add() agrees', async () => {
    (driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'reader', name: 'mokuro-reader', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'hist', name: 'history', mimeType: 'application/vnd.google-apps.folder', parents: ['reader'] },
      { id: 'dev', name: 'dev-a', mimeType: 'application/vnd.google-apps.folder', parents: ['hist'] },
      { id: 'seg', name: '2026-10.events', mimeType: 'application/octet-stream', parents: ['dev'], modifiedTime: '2026-10-03T00:00:00.000Z', size: '42' }
    ]);
    await driveFilesCache.fetch();
    expect(driveFilesCache.get('history/dev-a/2026-10.events')?.fileId).toBe('seg');

    driveFilesCache.add('history/dev-b/2026-10.events', {
      provider: 'google-drive', fileId: 'up', name: '2026-10.events', path: 'history/dev-b/2026-10.events',
      modifiedTime: '2026-10-04T00:00:00.000Z', size: 7, modifiedTimeProvisional: true
    } as never);
    expect(driveFilesCache.get('history/dev-b/2026-10.events')?.fileId).toBe('up');
  });
});
```

(If `add()` notifications coalesce — see the file's `CACHE_MUTATION_COALESCE_MS` tests — read with the same pattern those tests use, e.g. `await vi.advanceTimersByTimeAsync(CACHE_MUTATION_COALESCE_MS)` under fake timers.)

OneDrive (`onedrive-provider.test.ts`, follow its existing graph-client mock): uploading `history/dev-a/2026-10.events` when neither folder exists creates `history` under `mokuro-reader`, then `dev-a` under `mokuro-reader/history` — assert the `createFolder` mock calls are `[('mokuro-reader','history'), ('mokuro-reader/history','dev-a')]` in that order, and never a name containing `/`.

WebDAV (`webdav-provider.test.ts`, follow its listing mock): a listing containing `mokuro-reader/history/dev-a/2026-10.events` and `mokuro-reader/Series/device.json` yields the history file at path `history/dev-a/2026-10.events` and not the series one.

MEGA (`mega-provider.test.ts`, follow its node-tree mock): a `2026-10.events` node under `mokuro-reader/history/dev-a` lists at `history/dev-a/2026-10.events`; one under `mokuro-reader/Series` does not list.

- [ ] **Step 2: Run** the five test files → the new tests FAIL.

- [ ] **Step 3: Implement.**

`drive-history-path.ts`:

```ts
import { HISTORY_FOLDER, isHistoryFilePath } from '$lib/reading-history/paths';

/**
 * Drive lists the whole account flat; every other file type is cached by its
 * immediate parent (`<Series>/<file>`). History is two folders deep, so walk
 * up: file → <device> → history → mokuro-reader. Anything else is not ours.
 */
export function driveHistoryPath(
  file: { name: string; parents?: string[] },
  folders: Map<string, { name: string; parent?: string }>,
  readerFolderName: string
): string | null {
  const device = file.parents?.[0] ? folders.get(file.parents[0]) : undefined;
  const history = device?.parent ? folders.get(device.parent) : undefined;
  const reader = history?.parent ? folders.get(history.parent) : undefined;
  if (!device || history?.name !== HISTORY_FOLDER || reader?.name !== readerFolderName) return null;
  const path = `${HISTORY_FOLDER}/${device.name}/${file.name}`;
  return isHistoryFilePath(path) ? path : null;
}
```

`drive-files-cache.ts` `fetchAllFiles`: alongside `folderNames`, build `folders = new Map<string, {name, parent}>()` from every folder item (`parent: item.parents?.[0]`); in the classification loop add, BEFORE the sidecar/root-config branches, `else if (isHistoryFileName(item.name)) historyFiles.push(item);`; after the root-config loop, for each history file compute `driveHistoryPath(file, folders, GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER)`; when non-null push metadata (same shape as the sidecar branch, `path` = that path) into `cacheMap` under key `HISTORY_FOLDER`. `add()`: replace `parts.slice(0, -1).join('/')` with `parts[0]` as the group key (comment: `has/get/getAll` look up by the first segment; for every existing 2-segment path the two were identical) — keep `volumeTitle` as is.

`google-drive-provider.ts` `listCloudVolumes`: same `folders` map + `historyFiles` + `driveHistoryPath`, push into `cloudVolumes` with the full path. `performUpload` MIME: before the `.cbz` fallback add `: lowerFileName.endsWith('.events') ? 'application/octet-stream'`.

`webdav-provider.ts`: at both listing sites compute `relativePath` first and test `isSyncableFile(relativePath)` (the existing basename-only rules give the same answer for every non-history path because they look at the basename of whatever they are given).

`mega-provider.ts`: `const isHistory = isHistoryFileName(name);` and `if (!isCbz && !isSidecar && !isJson && !isHistory) continue;`; after `path` is computed, `if (isHistory && !isHistoryFilePath(path)) continue;` (a stray `device.json` in a series folder is not ours). Keep the `isJson && pathParts.length === 0` root branch unchanged.

`onedrive-provider.ts` `ensureSeriesFolder(seriesTitle)`: keep the existing fast path and promise coalescing; inside the promise replace the single `createFolderTolerant(MOKURO_FOLDER, seriesTitle)` with a walk:

```ts
await this.ensureMokuroFolder();
let parent = ONEDRIVE_CONFIG.MOKURO_FOLDER;
let id = '';
for (const segment of seriesTitle.split('/')) {
  const token = await onedriveTokenManager.getAccessToken();
  const here = `${parent}/${segment}`;
  const existing = await getItemByPath(token, here);
  id = existing ? existing.id : await this.createFolderTolerant(parent, segment);
  parent = here;
}
return id;
```

- [ ] **Step 4: Run** the five files plus `npx vitest run src/lib/util/sync` → all PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): list and upload history/<device>/ files on every provider"`

---

### Task 5: The history sync pass

**Files:**
- Create: `src/lib/reading-history/history-sync.ts`
- Test: `src/lib/reading-history/history-sync.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `getOrCreateDeviceId(db)` (`./record`); `DeviceFacts` (`./types`); `sourceStampChanged` (`$lib/metadata/series-index`); `CloudFileMetadata`, `SyncProvider`, `UploadFileResult` (`$lib/util/sync/provider-interface`)
- Produces:

```ts
export interface HistorySyncOptions {
  /** Upload the current month even if it went up less than UPLOAD_INTERVAL_MS ago. */
  force?: boolean;
  now?: number;
  onUploaded?: (path: string, bytes: number, result: UploadFileResult) => void;
}
export interface HistorySyncResult { imported: number; uploaded: string[]; failed: string[] }
export const UPLOAD_INTERVAL_MS = 5 * 60 * 1000;
export async function syncHistory(
  provider: SyncProvider,
  listing: CloudFileMetadata[],
  db: HistoryDexie,
  options?: HistorySyncOptions
): Promise<HistorySyncResult>;
```

Upload marks live in `history_meta` under `uploaded:<provider>:<month>` = `{ last_seq: number; count: number; at: number }` and `uploaded:<provider>:device` = `{ facts: string }`.

Rules:
1. **Import** every listed file whose parsed device ≠ own and whose `history_files` record is missing or `sourceStampChanged(record, file, provider.type)`; ≤ 4 downloads at once. Month file: `decodeSegment`; header `device`/`month` must equal the path's; every event's month must equal the header month; then ONE `rw` transaction over `reading_events` + `history_files`: for each event, `get([device, seq])` — absent → add; present with different JSON → log anomaly once (`console.warn`), keep the stored one; then put the stamp record (`last_seq` = header.last_seq; a lower value than the old record's → `console.warn` anomaly, nothing deleted). Any failure (download, decode, validation) → skip the file, record nothing. Device file: JSON `DeviceFacts` whose `device` equals the path's → `devices.put` keeping the later `last_seen`; then stamp.
2. **Export** only if `!status.serverCompilesMetadata && !status.isReadOnly`. Group own events (`reading_events.where('[device+seq]').between([own, Dexie.minKey], [own, Dexie.maxKey])`) by `historyMonthOf(t)`. For each month whose mark is missing or whose `{last_seq, count}` differs, OR whose path is absent from `listing` (deleted remotely): skip the CURRENT month (`historyMonthOf(now)`) when `!force && now - mark.at < UPLOAD_INTERVAL_MS`; else encode, `provider.uploadFile(path, bytes)`, `onUploaded?.(…)`, write the mark. A throw → push path to `failed`, no mark, continue with the next month.
3. **Device facts**: own `devices` row; `facts` = `JSON.stringify({ ...row, last_seen: undefined })`; upload `device.json` when the mark differs or the path is absent from `listing`.

- [ ] **Step 1: Failing tests** (`fake-indexeddb/auto`, a fresh `HistoryDexie` per test with a random name, a fake provider):

```ts
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryDexie } from './history-db';
import { appendEvent, getOrCreateDeviceId } from './record';
import { encodeSegment } from './segment-codec';
import { historySegmentPath, historyDeviceFilePath } from './paths';
import { syncHistory } from './history-sync';
import type { CloudFileMetadata, SyncProvider } from '$lib/util/sync/provider-interface';
import type { ReadingEvent } from './types';

const OCT = Date.UTC(2026, 9, 3);
const NOV = Date.UTC(2026, 10, 2);

function fakeCloud(status: { serverCompilesMetadata?: boolean; isReadOnly?: boolean } = {}) {
  const files = new Map<string, { bytes: Uint8Array; mtime: string }>();
  let clock = 0;
  const provider = {
    type: 'webdav',
    getStatus: () => ({ isAuthenticated: true, hasStoredCredentials: true, needsAttention: false, statusMessage: '', ...status }),
    uploadFile: vi.fn(async (path: string, blob: Uint8Array) => {
      files.set(path, { bytes: new Uint8Array(blob), mtime: new Date(++clock * 1000).toISOString() });
      return { fileId: path };
    }),
    downloadFile: vi.fn(async (f: CloudFileMetadata) => new Blob([files.get(f.path)!.bytes]))
  } as unknown as SyncProvider;
  const listing = (): CloudFileMetadata[] =>
    [...files].map(([path, f]) => ({ provider: 'webdav', fileId: path, path, modifiedTime: f.mtime, size: f.bytes.length }));
  return { provider, files, listing };
}

const page = (volume: string, first: number) => ({
  kind: 'page' as const, volume, first_page: first, last_page: first, page_chars: [10],
  chars_before: first * 10, dwell_ms: 5000, layout: 'single' as const, orientation: 'portrait' as const,
  viewport: { w: 400, h: 800 }
});

let a: HistoryDexie;
let b: HistoryDexie;
beforeEach(() => {
  a = new HistoryDexie(`a-${Math.random()}`);
  b = new HistoryDexie(`b-${Math.random()}`);
});

describe('syncHistory', () => {
  it("uploads own months and imports the other device's, in both directions", async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await appendEvent(a, page('v1', 2), NOV);
    await appendEvent(b, page('v2', 7), NOV);
    const devA = await getOrCreateDeviceId(a);

    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    expect([...cloud.files.keys()].sort()).toEqual([
      historySegmentPath(devA, '2026-10'), historySegmentPath(devA, '2026-11')
    ]);
    const r = await syncHistory(cloud.provider, cloud.listing(), b, { force: true, now: NOV });
    expect(r.imported).toBe(2);
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });

    const key = (e: ReadingEvent) => `${e.device}:${e.seq}`;
    expect((await a.reading_events.toArray()).map(key).sort()).toEqual((await b.reading_events.toArray()).map(key).sort());
    expect(await a.reading_events.count()).toBe(3);
  });

  it('is idempotent: a second pass downloads and uploads nothing', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    await syncHistory(cloud.provider, cloud.listing(), b, { force: true, now: NOV });
    vi.mocked(cloud.provider.uploadFile).mockClear();
    vi.mocked(cloud.provider.downloadFile).mockClear();
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    const r = await syncHistory(cloud.provider, cloud.listing(), b, { force: true, now: NOV });
    expect(cloud.provider.uploadFile).not.toHaveBeenCalled();
    expect(cloud.provider.downloadFile).not.toHaveBeenCalled();
    expect(r.imported).toBe(0);
  });

  it('the same file listed twice imports once', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    const listed = cloud.listing();
    await syncHistory(cloud.provider, [...listed, { ...listed[0], fileId: 'dup' }], b, { now: NOV });
    expect(await b.reading_events.count()).toBe(1);
  });

  it('a corrupt file imports nothing and is retried once it is fixed', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    const devA = await getOrCreateDeviceId(a);
    const path = historySegmentPath(devA, '2026-10');
    cloud.files.set(path, { bytes: new Uint8Array([9, 9, 9]), mtime: 'Mon, 05 Oct 2026 00:00:00 GMT' });
    await syncHistory(cloud.provider, cloud.listing(), b, { now: NOV });
    expect(await b.reading_events.count()).toBe(0);
    expect(await b.history_files.get(path)).toBeUndefined();
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    await syncHistory(cloud.provider, cloud.listing(), b, { now: NOV });
    expect(await b.reading_events.count()).toBe(1);
  });

  it("refuses a file whose events belong to another device than its folder", async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    const events = await a.reading_events.toArray();
    const devA = events[0].device;
    cloud.files.set(historySegmentPath('impostor', '2026-10'), {
      bytes: await encodeSegment(devA, '2026-10', events), mtime: 'Mon, 05 Oct 2026 00:00:00 GMT'
    });
    await syncHistory(cloud.provider, cloud.listing(), b, { now: NOV });
    expect(await b.reading_events.count()).toBe(0);
  });

  it('never re-uploads imported events: B uploads only its own folder', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await appendEvent(b, page('v2', 1), OCT);
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    await syncHistory(cloud.provider, cloud.listing(), b, { force: true, now: NOV });
    const devB = await getOrCreateDeviceId(b);
    const bUploads = vi.mocked(cloud.provider.uploadFile).mock.calls.map((c) => c[0]).filter((p) => !p.includes(devB));
    expect(bUploads.every((p) => !p.startsWith(`history/${devB}`))).toBe(true);
    expect([...cloud.files.keys()].filter((p) => p.startsWith(`history/${devB}/`))).toEqual([historySegmentPath(devB, '2026-10')]);
  });

  it('throttles the current month unless forced; closed months always go up', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), NOV);
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    await appendEvent(a, page('v1', 2), NOV + 1000);
    vi.mocked(cloud.provider.uploadFile).mockClear();
    await syncHistory(cloud.provider, cloud.listing(), a, { now: NOV + 60_000 });
    expect(cloud.provider.uploadFile).not.toHaveBeenCalled();
    await syncHistory(cloud.provider, cloud.listing(), a, { now: NOV + 6 * 60_000 });
    expect(cloud.provider.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('a failed month upload is retried next time and does not block the others', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await appendEvent(a, page('v1', 2), NOV);
    vi.mocked(cloud.provider.uploadFile).mockImplementationOnce(async () => { throw new Error('offline'); });
    const r = await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    expect(r.failed).toHaveLength(1);
    expect(r.uploaded).toHaveLength(1);
    const r2 = await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    expect(r2.uploaded).toEqual(r.failed);
  });

  it('uploads everything again to a new provider', async () => {
    const first = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await syncHistory(first.provider, first.listing(), a, { force: true, now: NOV });
    const second = fakeCloud();
    (second.provider as { type: string }).type = 'mega';
    const r = await syncHistory(second.provider, second.listing(), a, { force: true, now: NOV });
    expect(r.uploaded).toHaveLength(1);
  });

  it.each([{ serverCompilesMetadata: true }, { isReadOnly: true }])('never uploads on %o, still imports', async (status) => {
    const shared = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await syncHistory(shared.provider, shared.listing(), a, { force: true, now: NOV });
    const limited = { ...shared, provider: { ...shared.provider, getStatus: () => ({ ...shared.provider.getStatus(), ...status }), uploadFile: vi.fn() } as unknown as SyncProvider };
    await appendEvent(b, page('v2', 1), OCT);
    await syncHistory(limited.provider, shared.listing(), b, { force: true, now: NOV });
    expect(limited.provider.uploadFile).not.toHaveBeenCalled();
    expect(await b.reading_events.count()).toBe(2);
  });

  it('uploads device facts once, and imports the other device\'s', async () => {
    const cloud = fakeCloud();
    const devA = await getOrCreateDeviceId(a);
    await a.devices.put({ device: devA, class: 'phone', os: 'Android', first_seen: 'x', last_seen: 'y' });
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    expect(cloud.files.has(historyDeviceFilePath(devA))).toBe(true);
    await a.devices.update(devA, { last_seen: 'z' });
    vi.mocked(cloud.provider.uploadFile).mockClear();
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    expect(cloud.provider.uploadFile).not.toHaveBeenCalled();
    await syncHistory(cloud.provider, cloud.listing(), b, { now: NOV });
    expect((await b.devices.get(devA))?.class).toBe('phone');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/reading-history/history-sync.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `history-sync.ts` per the rules above (import first, then export; device facts last). Use `Dexie.minKey/maxKey` for the own-device range; `new Uint8Array(await blob.arrayBuffer())` for downloads; a small `runPool(items, 4, fn)` local helper; one `console.warn` per anomaly kind per pass.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(history): sync pass — upload own months, import other devices'"`

---

### Task 6: Run the pass on every progress sync

**Files:**
- Modify: `src/lib/util/sync/unified-sync-service.ts` (`syncProvider`, new private `syncReadingHistory`)
- Test: `src/lib/util/sync/unified-sync-service.test.ts`

**Interfaces:**
- Consumes: `syncHistory`, `historyDb` (lazy `import()`), `isHistoryFilePath`, `uploadCacheEntry`.

- [ ] **Step 1: Failing tests** (in `unified-sync-service.test.ts`; add `vi.mock('$lib/reading-history/history-sync', () => ({ syncHistory: vi.fn(async () => ({ imported: 0, uploaded: [], failed: [] })) }))` and `vi.mock('$lib/reading-history/history-db', () => ({ historyDb: vi.fn(() => ({})) }))` at the top):

```ts
describe('reading history rides every sync', () => {
  it('passes only history files from a loaded listing, forced on a manual sync', async () => {
    const { syncHistory } = await import('$lib/reading-history/history-sync');
    const files = [
      { provider: 'mega', fileId: '1', path: 'history/dev-a/2026-10.events', modifiedTime: 'm', size: 1 },
      { provider: 'mega', fileId: '2', path: 'volume-data.json', modifiedTime: 'm', size: 1 }
    ];
    getCache.mockReturnValue({ getAll: vi.fn(() => []), get: vi.fn(() => null), fetch: vi.fn(), isLoaded: () => true, isFetching: () => false, getAllFiles: () => files, add: vi.fn() });
    const provider = { type: 'mega', name: 'MEGA', isAuthenticated: () => true, downloadFile: vi.fn(), uploadFile: vi.fn(async () => ({ fileId: 'x' })) } as unknown as SyncProvider;
    await svc.syncReadingHistory(provider, { silent: false });
    expect(vi.mocked(syncHistory).mock.calls[0][1]).toEqual([files[0]]);
    expect(vi.mocked(syncHistory).mock.calls[0][3]?.force).toBe(true);
  });

  it('a failing history pass never fails the sync', async () => {
    const { syncHistory } = await import('$lib/reading-history/history-sync');
    vi.mocked(syncHistory).mockRejectedValueOnce(new Error('boom'));
    getCache.mockReturnValue({ isLoaded: () => true, isFetching: () => false, getAllFiles: () => [] });
    await expect(svc.syncReadingHistory({ type: 'mega' } as SyncProvider, {})).resolves.toBeUndefined();
  });

  it('skips while the listing has not loaded', async () => {
    const { syncHistory } = await import('$lib/reading-history/history-sync');
    vi.mocked(syncHistory).mockClear();
    getCache.mockReturnValue({ isLoaded: () => false, isFetching: () => false, getAllFiles: () => [] });
    await svc.syncReadingHistory({ type: 'mega' } as SyncProvider, {});
    expect(syncHistory).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** → FAIL (`syncReadingHistory` is not a function).
- [ ] **Step 3: Implement** — in `syncProvider`, after the goals step: `await this.syncReadingHistory(provider, options);`. The method:

```ts
  /**
   * Reading history (spec: Storage → Cloud): upload this device's months,
   * import every other device's. Best-effort — it is this device's copy of
   * data it keeps locally, so a failure logs and the next sync retries; it
   * never fails the progress sync. Loaded lazily: the history database
   * module must not be evaluated by suites that mock `dexie`.
   */
  private async syncReadingHistory(provider: SyncProvider, options: SyncOptions = {}): Promise<void> {
    try {
      const cache = cacheManager.getCache(provider.type);
      if (!cache?.isLoaded?.() || cache.isFetching?.()) return;
      const listing = cache.getAllFiles().filter((f) => isHistoryFilePath(f.path));
      const [{ syncHistory }, { historyDb }] = await Promise.all([
        import('$lib/reading-history/history-sync'),
        import('$lib/reading-history/history-db')
      ]);
      const result = await syncHistory(provider, listing, historyDb(), {
        force: !options.silent,
        onUploaded: (path, bytes, uploaded) =>
          cache.add?.(path, uploadCacheEntry(provider.type, path, bytes, uploaded))
      });
      if (result.imported || result.uploaded.length || result.failed.length) {
        console.log('📚 Reading history:', result);
      }
    } catch (error) {
      console.warn('Reading history sync failed (will retry next sync):', error);
    }
  }
```

(Check `syncProvider`'s actual options parameter name/type and `uploadCacheEntry`'s exact signature — `uploadCacheEntry(providerType, path, uploadedBytes, uploaded, description?)` — and match them.)

- [ ] **Step 4: Run** `npx vitest run src/lib/util/sync` → PASS; full `npx vitest run` → PASS (watch for suites that now evaluate `history-sync` — the lazy import must keep `dexie` out of them).
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): reading history rides every progress sync"`

---

### Task 7: Two devices end to end

**Files:**
- Create: `e2e/history-sync.spec.ts` (copy the `WebDavStub` from `e2e/sync-diverged-reads.spec.ts`; store PUT bodies as `Buffer` via `request.postDataBuffer()` and serve them back as bytes)
- Modify: `CLAUDE.md` ("Reading history (`mokuro_history`)" section: phase 2a cloud layout, best-effort rule, bunko skip)

- [ ] **Step 1: Write the spec**: device A and B (separate contexts, same stub). A records 3 page events through `recordEvent` (dynamic import of `/src/lib/reading-history/record.ts`), then `fetchAllCloudVolumes()` + `syncProgress({ silent: false })`. Assert the stub holds `history/<A>/<YYYY-MM>.events` and `history/<A>/device.json`. B lists + syncs. Assert B's `mokuro_history.reading_events` (read via `historyDb()`) holds A's 3 events with A's device id and identical payloads. Sync both again: no new PUT under `history/` from either (except B's own first upload), and B still has exactly 3 of A's events.
- [ ] **Step 2: Run** `E2E_PORT=5199 E2E_CHROMIUM=$HOME/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome npx playwright test e2e/history-sync.spec.ts` → PASS (it would fail before Task 6: no PUTs under `history/`).
- [ ] **Step 3: Update CLAUDE.md**, run `npm run check` (0 errors) and the full unit suite.
- [ ] **Step 4: Commit** — `git commit -m "test(history): two devices exchange reading history through WebDAV"`
