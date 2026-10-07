import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { get: vi.fn(async () => undefined), bulkGet: vi.fn(async () => []) },
    volume_ocr: { get: vi.fn(async () => undefined) }
  }
}));

import { get } from 'svelte/store';
import { VolumeData, clearVolumes, volumesWithTrash } from '$lib/settings/volume-data';
import { HistoryDexie } from './history-db';
import { getOrCreateDeviceId, notifyEventsRecorded } from './record';
import { _resetHistoryTurns, loadHistoryTurns } from './turns-store';
import {
  _resetPositionStoreForTests,
  _newSessionForTests,
  answerPosition,
  initPositionOffers,
  markPrompted,
  positionPlanFor,
  shouldPrompt
} from './position-store';
import type { ReadingEvent } from './types';

let db: HistoryDexie;
let own: string;
let seq = 0;
const view = (device: string, t: number, page: number): ReadingEvent => ({
  device,
  seq: ++seq,
  t,
  kind: 'page',
  volume: 'v',
  first_page: page,
  last_page: page,
  page_chars: [10],
  chars_before: page * 10,
  dwell_ms: 1000,
  layout: 'single',
  orientation: 'portrait',
  viewport: null
});

async function store(events: ReadingEvent[]) {
  await db.reading_events.bulkAdd(events);
  notifyEventsRecorded(events);
  await Promise.resolve();
}

beforeEach(async () => {
  clearVolumes();
  window.localStorage.clear();
  _resetHistoryTurns();
  _resetPositionStoreForTests();
  db = new HistoryDexie(`pos-${Math.random()}`);
  own = await getOrCreateDeviceId(db);
  await loadHistoryTurns(db);
  await initPositionOffers(db);
});

describe('position store', () => {
  it('plans the offer for a volume from its events and record', async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 41 }) });
    await store([view('phone', 0, 120), view(own, 10_000, 40), view(own, 11_000, 41)]);
    expect(positionPlanFor('v').offer).toMatchObject({
      page: 120,
      device: 'phone',
      ownDevice: false
    });
  });

  it('Stay answers it for good', async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 41 }) });
    await store([view('phone', 0, 120), view(own, 10_000, 41)]);
    await answerPosition('v', positionPlanFor('v').offer!, 'stay', 200, db);
    await Promise.resolve();
    expect(positionPlanFor('v')).toEqual({});
    expect(get(volumesWithTrash).v.progress).toBe(41);
  });

  it('Jump moves there and answers it', async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 41 }) });
    await store([view('phone', 0, 120), view(own, 10_000, 41)]);
    await answerPosition('v', positionPlanFor('v').offer!, 'jump', 200, db);
    await Promise.resolve();
    expect(get(volumesWithTrash).v).toMatchObject({ progress: 120, chars: 1210, completed: false });
    expect(positionPlanFor('v')).toEqual({});
  });

  it('re-applies a restart the newest reading missed, once', async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 61, chars: 610 }) });
    const restart: ReadingEvent = {
      device: 'phone',
      seq: ++seq,
      t: 5_000,
      kind: 'restart',
      volume: 'v'
    };
    await store([view('phone', 0, 200), restart, view(own, 10_000, 60), view(own, 11_000, 61)]);
    await vi.waitFor(() => expect(get(volumesWithTrash).v.progress).toBe(0));
    const answers = (await db.reading_events.toArray()).filter((e) => e.kind === 'position');
    expect(answers).toHaveLength(1);
    expect(positionPlanFor('v').offer).toMatchObject({ page: 61, ownDevice: true });
  });

  it('prompts at most once a session, in at most two sessions', () => {
    const offer = { page: 120, chars: 1, at: 777, device: 'phone', ownDevice: false };
    expect(shouldPrompt('v', offer)).toBe(true);
    markPrompted('v', offer);
    expect(shouldPrompt('v', offer)).toBe(false);
    _newSessionForTests();
    expect(shouldPrompt('v', offer)).toBe(true);
    markPrompted('v', offer);
    _newSessionForTests();
    expect(shouldPrompt('v', offer)).toBe(false);
    // A new offer (newer reading) starts over.
    expect(shouldPrompt('v', { ...offer, at: 888 })).toBe(true);
  });

  it('waits while the reader has the volume open, and applies the reset once it closes (I5)', async () => {
    const { currentView } = await import('$lib/util/hash-router');
    currentView.set({ type: 'reader', seriesId: 's', volumeId: 'v' });
    volumesWithTrash.set({ v: new VolumeData({ progress: 61, chars: 610 }) });
    const restart: ReadingEvent = {
      device: 'phone',
      seq: ++seq,
      t: 5_000,
      kind: 'restart',
      volume: 'v'
    };
    await store([view('phone', 0, 200), restart, view(own, 10_000, 60), view(own, 11_000, 61)]);
    await new Promise((r) => setTimeout(r, 20));
    expect(get(volumesWithTrash).v.progress).toBe(61);
    currentView.set({ type: 'catalog' });
    await vi.waitFor(() => expect(get(volumesWithTrash).v.progress).toBe(0));
  });

  it('returns the same plan object while nothing about the volume changed', async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 41 }) });
    await store([view('phone', 0, 120), view(own, 10_000, 41)]);
    const first = positionPlanFor('v');
    expect(positionPlanFor('v')).toBe(first);
    await store([view(own, 12_000, 42)]);
    expect(positionPlanFor('v')).not.toBe(first);
  });
});
