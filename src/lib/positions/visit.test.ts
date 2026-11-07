import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/db', () => ({
  db: { volumes: { get: vi.fn().mockResolvedValue(undefined), bulkGet: vi.fn(async () => []) } }
}));

import {
  VolumeData,
  adoptPosition,
  clearVolumes,
  initializeVolume,
  registerCompletionListener,
  registerPositionListener,
  updateProgress,
  volumesWithTrash
} from '$lib/settings/volume-data';
import type { HistoryDexie } from '$lib/reading-history/history-db';
import { liveView } from '$lib/reading-history/live-view';
import { notifyEventsRecorded } from '$lib/reading-history/record';
import { _resetHistoryTurns, loadHistoryTurns } from '$lib/reading-history/turns-store';
import type { ReadingEvent } from '$lib/reading-history/types';
import { _resetEscapesForTests, noteUploaded } from './escapes';
import { reconcilePositions } from './positions-reconcile';
import { noteReaderClosed, noteReaderOpened, openReader } from './reader-open';
import { _resetPositionTracking, initPositionTracking, ownChangedEntries } from './positions-local';
import {
  _resetVisitsForTests,
  endVisit,
  initVisitTracking,
  rehomeVisit,
  startVisit
} from './visit';

const DEVICE = 'dev-a';
const START = Date.parse('2026-10-18T12:00:00.000Z');
const OLD = '2026-10-01T00:00:00.000Z';
const LAST_PAGE = 200;

let seq = 0;
let clock = START;
let open: { page: number; last: number; since: number } | null = null;
let stops: Array<() => void> = [];
let completions: string[] = [];
let notices: string[] = [];

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function pageEvent(page: number, since: number, dwell: number, last = page): ReadingEvent {
  return {
    device: DEVICE,
    seq: ++seq,
    t: since,
    kind: 'page',
    volume: 'v',
    first_page: page,
    last_page: last,
    page_chars: Array.from({ length: last - page + 1 }, () => 300),
    chars_before: (page - 1) * 300,
    dwell_ms: dwell,
    layout: 'single',
    orientation: 'portrait',
    viewport: { w: 1, h: 1 }
  };
}

/**
 * The reader showing `page` after `after` ms on the previous one: the new
 * view opens and the record moves at once; the ended view's event lands a
 * moment later (the history write is async), as in the app.
 */
interface ViewOptions {
  /** Last page on screen (continuous scroll shows several). */
  last?: number;
  /** The position the reader reports (default: the first page). */
  progress?: number;
}

async function show(page: number, after = 0, options: ViewOptions = {}) {
  await land(await turn(page, after, options));
}

/** The turn alone: the ended view's event not landed yet. */
async function turn(page: number, after = 0, { last = page, progress = page }: ViewOptions = {}) {
  clock += after;
  vi.setSystemTime(clock);
  const ended = open;
  open = { page, last, since: clock };
  liveView.set({
    view: {
      volume: 'v',
      first_page: page,
      last_page: last,
      page_chars: Array.from({ length: last - page + 1 }, () => 300),
      chars_before: (page - 1) * 300,
      layout: 'single',
      orientation: 'portrait',
      viewport: { w: 1, h: 1 }
    },
    since: clock
  });
  updateProgress('v', progress, progress * 300, progress === LAST_PAGE);
  await flush();
  return ended && pageEvent(ended.page, ended.since, clock - ended.since, ended.last);
}

async function land(event: ReadingEvent | null) {
  if (event) notifyEventsRecorded([event]);
  await flush();
}

const record = () => get(volumesWithTrash).v;
const QUICK = 800;
const READ = 20_000; // 300 chars in 20 s: reading pace

function setRecord(progress: number, lastProgressUpdate = OLD, completed = false) {
  volumesWithTrash.set({
    v: new VolumeData({
      progress,
      chars: progress * 300,
      completed,
      lastProgressUpdate,
      series_uuid: 's'
    })
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  clock = START;
  vi.setSystemTime(clock);
  open = null;
  localStorage.clear();
  clearVolumes();
  liveView.set(null);
  _resetPositionTracking();
  _resetEscapesForTests();
  _resetVisitsForTests();
  _resetHistoryTurns();
  await loadHistoryTurns({
    reading_events: { toArray: async () => [] }
  } as unknown as HistoryDexie);
  completions = [];
  notices = [];
  // Visit tracking first and the push marks after: the restore must not leave
  // its old stamp marked as ours whatever order the listeners run in.
  stops = [
    initVisitTracking(DEVICE),
    initPositionTracking(),
    registerCompletionListener((id) => completions.push(id)),
    registerPositionListener((id) => notices.push(id))
  ];
});

afterEach(() => {
  stops.forEach((stop) => stop());
  vi.useRealTimers();
});

describe('look-up visits (live)', () => {
  it('two quick peeks and back: the record gets its pre-visit stamp back, nothing to push', async () => {
    setRecord(40);
    startVisit('v', clock);
    await show(40);
    await show(41, READ);
    await show(42, QUICK);
    await show(40, QUICK);
    expect([record().progress, record().chars, record().lastProgressUpdate]).toEqual([
      40,
      12_000,
      OLD
    ]);
    expect(ownChangedEntries(DEVICE)).toEqual({});
  });

  it('the ended view landing before the record moves: still nothing to push', async () => {
    // The reader may report the page a tick after its view changed; then the
    // restore runs on the position notice itself, among the other listeners.
    setRecord(40);
    startVisit('v', clock);
    await show(40);
    await show(41, READ);
    clock += QUICK;
    vi.setSystemTime(clock);
    const ended = pageEvent(41, open!.since, QUICK);
    open = { page: 40, last: 40, since: clock };
    liveView.set({
      view: { ...get(liveView)!.view, first_page: 40, last_page: 40, chars_before: 39 * 300 },
      since: clock
    });
    await land(ended);
    updateProgress('v', 40, 12_000, false);
    await flush();
    expect(record().lastProgressUpdate).toBe(OLD);
    expect(ownChangedEntries(DEVICE)).toEqual({});
  });

  it('an unread volume peeked at and left on p.1 stays unread (progress 0, epoch stamp)', async () => {
    initializeVolume('v');
    startVisit('v', clock);
    await show(1);
    await show(2, READ);
    await show(1, QUICK);
    expect(record().progress).toBe(0);
    expect(record().chars).toBe(0);
    expect(record().lastProgressUpdate).toBe(new Date(0).toISOString());
    expect(ownChangedEntries(DEVICE)).toEqual({});
  });

  it('a peek whose stamp was uploaded restores with newestUploaded + 1', async () => {
    setRecord(40);
    startVisit('v', clock);
    await show(40);
    await show(41, READ);
    const peekStamp = Date.parse(record().lastProgressUpdate);
    clock += 4000; // the 3 s push went out with p.41
    noteUploaded('v', peekStamp);
    notices = [];
    await show(40);
    expect(record().progress).toBe(40);
    expect(Date.parse(record().lastProgressUpdate)).toBe(peekStamp + 1);
    expect(notices).toEqual(['v', 'v']); // the turn home, then the restore
    expect(ownChangedEntries(DEVICE).v).toMatchObject({ t: peekStamp + 1, page: 40 });
  });

  it('another device’s position landing mid-visit is never undone', async () => {
    setRecord(40);
    startVisit('v', clock);
    await show(40);
    await show(41, READ);
    // An idle volume-data.json merge brings the phone's newer position.
    clock += 100;
    setRecord(60, new Date(clock).toISOString());
    await flush();
    await show(40, QUICK);
    expect(record().progress).toBe(40);
    expect(Date.parse(record().lastProgressUpdate)).toBe(clock);
  });

  it('three pages read, then back home: no restore (reading)', async () => {
    setRecord(40);
    startVisit('v', clock);
    await show(40);
    await show(41, READ);
    await show(42, READ);
    await show(43, READ);
    await show(40, READ);
    expect(record().progress).toBe(40);
    expect(Date.parse(record().lastProgressUpdate)).toBe(clock);
  });

  it('three pages read, the last one still in flight: never judged early', async () => {
    // The view of p.43 ends with the turn home, but its event lands after the
    // record moved: judged then, with three read pages, it is reading.
    setRecord(40);
    startVisit('v', clock);
    await show(40);
    await show(41, READ);
    await show(42, READ);
    await show(43, READ);
    const inFlight = await turn(40, READ);
    // Judged now, without p.43, it would be two read pages: a look-up.
    expect(Date.parse(record().lastProgressUpdate)).toBe(clock);
    await land(inFlight);
    expect(Date.parse(record().lastProgressUpdate)).toBe(clock);
  });

  it('a lost snapshot (reload) restores nothing and throws nothing', async () => {
    setRecord(40);
    startVisit('v', clock);
    await show(40);
    await show(41, READ);
    _resetVisitsForTests();
    await show(40, QUICK);
    expect(record().progress).toBe(40);
    expect(Date.parse(record().lastProgressUpdate)).toBe(clock);
  });

  it('peek at the last page of an unread volume and back: not completed, no completion notice at endVisit', async () => {
    initializeVolume('v');
    startVisit('v', clock);
    await show(1);
    await show(LAST_PAGE, READ);
    expect(record().completed).toBe(true);
    await show(1, QUICK);
    expect(record().completed).toBe(false);
    endVisit('v');
    expect(completions).toEqual([]);
  });

  it('finish on the last page, hide the tab, then close: one completion notice', async () => {
    setRecord(LAST_PAGE - 1);
    startVisit('v', clock);
    await show(LAST_PAGE - 1);
    await show(LAST_PAGE, READ);
    expect(completions).toEqual([]);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(completions).toEqual(['v']);
    endVisit('v');
    expect(completions).toEqual(['v']);
  });

  it('finish on the last page, then the page is unloaded while visible: one completion notice', async () => {
    // A tab killed or navigated away while visible never fires the hidden
    // visibility change; `pagehide` is the last chance to announce.
    setRecord(LAST_PAGE - 1);
    startVisit('v', clock);
    await show(LAST_PAGE - 1);
    await show(LAST_PAGE, READ);
    expect(completions).toEqual([]);
    window.dispatchEvent(new Event('pagehide'));
    expect(completions).toEqual(['v']);
    endVisit('v');
    expect(completions).toEqual(['v']);
  });

  it('a late adoption before any turn re-homes the visit', async () => {
    setRecord(40);
    startVisit('v', clock);
    await show(40);
    clock += 500;
    vi.setSystemTime(clock);
    const remote = Date.parse(OLD) + 86_400_000;
    expect(adoptPosition('v', 60, 18_000, false, remote)).toBe(true);
    rehomeVisit('v');
    await show(60); // the reader follows the adopted page: no turn of ours
    await show(61, READ);
    await show(60, QUICK);
    expect(record().progress).toBe(60);
    expect(Date.parse(record().lastProgressUpdate)).toBe(remote);
  });

  it('reopening within the gap continues the visit and its snapshot', async () => {
    setRecord(40);
    startVisit('v', clock);
    await show(40);
    await show(41, READ);
    // Closed on p.41 after a quick look: its view ends with the reader.
    clock += QUICK;
    vi.setSystemTime(clock);
    const closing = pageEvent(41, open!.since, QUICK);
    open = null;
    liveView.set(null);
    endVisit('v');
    await land(closing);
    clock += 60_000;
    startVisit('v', clock);
    await show(40);
    expect(record().lastProgressUpdate).toBe(OLD);
  });

  it('a real read that finishes is announced at once, as today', async () => {
    // Pages 196 → 200: three read away from home before the last page.
    // Three pages read before the last: this visit can never be a look-up, so
    // nothing waits — paging back below the window and closing loses nothing.
    setRecord(LAST_PAGE - 4);
    startVisit('v', clock);
    await show(LAST_PAGE - 4);
    await show(LAST_PAGE - 3, READ);
    await show(LAST_PAGE - 2, READ);
    await show(LAST_PAGE - 1, READ);
    await show(LAST_PAGE, READ);
    expect(completions).toEqual(['v']);
    await show(LAST_PAGE - 4, READ); // back to where it began: still reading
    endVisit('v');
    expect(completions).toEqual(['v']);
  });

  it('in the reader’s own order (record first, view after) a real finish is announced at once', async () => {
    setRecord(LAST_PAGE - 4);
    startVisit('v', clock);
    await show(LAST_PAGE - 4);
    await show(LAST_PAGE - 3, READ);
    await show(LAST_PAGE - 2, READ);
    await show(LAST_PAGE - 1, READ);
    // p.199 (the third page read) is still the live view when the record reaches the last page.
    clock += READ;
    vi.setSystemTime(clock);
    updateProgress('v', LAST_PAGE, LAST_PAGE * 300, true);
    expect(completions).toEqual(['v']);
  });

  it('a restore never moves the page on screen (continuous scroll)', async () => {
    // The home view shows pages 38–42 at position 40; after a peek the
    // reader settles on 41, still inside home. Restoring p.40 would scroll it.
    setRecord(40);
    startVisit('v', clock);
    await show(38, 0, { last: 42, progress: 40 });
    await show(50, READ, { last: 54, progress: 52 });
    await show(39, QUICK, { last: 43, progress: 41 });
    expect(record().progress).toBe(41);
  });

  it('after a restore, a newer position elsewhere is offered, not jumped to', async () => {
    setRecord(40);
    noteReaderOpened('v', clock);
    startVisit('v', clock);
    await show(40);
    await show(41, READ);
    await show(40, QUICK);
    expect(record().lastProgressUpdate).toBe(OLD);
    const plan = reconcilePositions({
      cloud: { v: { t: clock + 1000, page: 60, chars: 18_000, device: 'phone' } },
      cloudContent: 'x',
      local: () => ({
        stamp: Date.parse(record().lastProgressUpdate),
        deleted: false,
        forgotAt: 0
      }),
      own: {},
      ownDevice: DEVICE,
      open: openReader(),
      now: clock + 2000
    });
    expect(plan.adopt).toEqual([]);
    expect(plan.deferred).toEqual(['v']);
    noteReaderClosed('v');
  });

  it('a merge while the reader is closed spoils the continued visit', async () => {
    setRecord(40);
    startVisit('v', clock);
    await show(40);
    await show(41, READ);
    clock += QUICK;
    vi.setSystemTime(clock);
    const closing = pageEvent(41, open!.since, QUICK);
    open = null;
    liveView.set(null);
    endVisit('v');
    await land(closing);
    // The phone's newer position arrives with an idle volume-data.json merge.
    clock += 30_000;
    setRecord(60, new Date(clock).toISOString());
    await flush();
    clock += 30_000;
    startVisit('v', clock);
    await show(40);
    expect(record().progress).toBe(40);
    expect(Date.parse(record().lastProgressUpdate)).toBe(clock);
  });

  it('sitting home after an escaped restore re-pushes nothing', async () => {
    setRecord(40);
    startVisit('v', clock);
    await show(40);
    await show(41, READ);
    const peekStamp = Date.parse(record().lastProgressUpdate);
    noteUploaded('v', peekStamp);
    await show(40, 4000);
    expect(Date.parse(record().lastProgressUpdate)).toBe(peekStamp + 1);
    noteUploaded('v', peekStamp + 1); // the restore went up
    notices = [];
    // The tab hides and shows: the home view ends and reopens, its event lands.
    clock += 5000;
    vi.setSystemTime(clock);
    const home = pageEvent(40, open!.since, 5000);
    liveView.set(null);
    open = null;
    await land(home);
    await show(40, 1000);
    expect(notices).toEqual([]);
    expect(Date.parse(record().lastProgressUpdate)).toBe(peekStamp + 1);
  });
});
