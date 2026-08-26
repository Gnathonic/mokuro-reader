import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';

/**
 * The ADAPTIVE flush cadence (`cover-persist.ts`'s `armTimer`/
 * `runScheduledFlush`), under fake timers — split out from
 * `cover-persist.test.ts` because real Dexie (`fake-indexeddb`) hangs under
 * `vi.useFakeTimers()` (see `cover-service.retry.test.ts`'s note, the same
 * issue). `db` here is a plain in-memory stub, same pattern.
 *
 * Field evidence: a sustained ~1,300-cover convergence backlog (draining at
 * the backfill semaphore's 2-wide cap) was producing a coalesced write every
 * 750ms, each one costing a multi-second catalog re-derive — the main
 * thread ran long tasks back-to-back for the whole convergence window. The
 * fix widens the flush window under SUSTAINED back-to-back arrival (up to
 * `COVER_PERSIST_MAX_DELAY_MS`) while leaving a single interactive wave (a
 * screenful of cards, nothing following it) at the base 750ms cadence.
 */

vi.mock('$lib/catalog/thumbnail-cache', () => ({
  thumbnailCache: { invalidate: vi.fn() }
}));

const { volumeRows, transactionSpy } = vi.hoisted(() => ({
  volumeRows: [] as VolumeMetadata[],
  transactionSpy: vi.fn()
}));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      get: async (uuid: string) => volumeRows.find((v) => v.volume_uuid === uuid),
      put: async (row: VolumeMetadata) => {
        volumeRows.push(row);
      },
      update: async (uuid: string, patch: Record<string, unknown>) => {
        const r = volumeRows.find((v) => v.volume_uuid === uuid);
        if (r) Object.assign(r, patch);
      }
    },
    transaction: (_mode: string, _table: unknown, body: () => Promise<unknown>) => {
      transactionSpy();
      return body();
    }
  }
}));

// `cover-persist.ts`'s flush now consults the reading-state store
// (`$lib/settings/volume-data`) to tell a genuine relationship apart from a
// row minted purely by browsing. Hand-rolled (same pattern as
// `cover-persist.test.ts`) so `row()` below can mark itself as a
// relationship without touching real localStorage — this file's own concern
// is the flush CADENCE, not routing, so every row here should land as it did
// before this gate existed.
const readingHistory = vi.hoisted(() => {
  let value: Record<string, unknown> = {};
  const subs = new Set<(v: Record<string, unknown>) => void>();
  return {
    store: {
      subscribe(fn: (v: Record<string, unknown>) => void) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      }
    },
    set(next: Record<string, unknown>) {
      value = next;
      subs.forEach((fn) => fn(value));
    }
  };
});
vi.mock('$lib/settings/volume-data', () => ({
  volumes: readingHistory.store
}));

import { db } from '$lib/catalog/db';
import {
  _resetCoverPersistForTests,
  COVER_PERSIST_BASE_DELAY_MS,
  COVER_PERSIST_MAX_DELAY_MS,
  installCover
} from './cover-persist';
import type { CloudThumbnailResult } from './cloud-thumbnails';

// This file pushes MANY rows per test (write-storm waves) — accumulate
// rather than clobber, since `row()` is called once per uuid.
let historyEntries: Record<string, unknown> = {};

function row(uuid: string): VolumeMetadata {
  historyEntries = { ...historyEntries, [uuid]: { progress: 1 } };
  readingHistory.set(historyEntries);
  return {
    volume_uuid: uuid,
    series_uuid: 's',
    series_title: 'One Piece',
    volume_title: uuid,
    mokuro_version: '0.4.11',
    page_count: 5,
    character_count: 50,
    page_char_counts: [50],
    metadata_only: true
  } as VolumeMetadata;
}

function coverResult(name: string): CloudThumbnailResult {
  return { file: new File(['img'], name, { type: 'image/webp' }), width: 210, height: 297 };
}

beforeEach(() => {
  _resetCoverPersistForTests();
  transactionSpy.mockClear();
  volumeRows.length = 0;
  historyEntries = {};
  readingHistory.set({});
});

afterEach(() => {
  _resetCoverPersistForTests();
  vi.useRealTimers();
});

describe('requirement (b): the interactive case stays snappy', () => {
  it('a single wave — everything queued together, nothing following — costs exactly one flush at the base delay', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 20; i++) {
      volumeRows.push(row(`v-${i}`));
      installCover(`v-${i}`, coverResult(`${i}.webp`));
    }

    // Just short of the base delay: nothing has flushed yet.
    await vi.advanceTimersByTimeAsync(COVER_PERSIST_BASE_DELAY_MS - 1);
    expect(transactionSpy).not.toHaveBeenCalled();

    // Exactly at the base delay: the one and only flush for this wave.
    await vi.advanceTimersByTimeAsync(1);
    expect(transactionSpy).toHaveBeenCalledTimes(1);

    // Nothing follows — no further flush ever fires, however long we wait.
    await vi.advanceTimersByTimeAsync(COVER_PERSIST_MAX_DELAY_MS * 2);
    expect(transactionSpy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 20; i++) {
      expect(volumeRows.find((r) => r.volume_uuid === `v-${i}`)?.thumbnail_width).toBe(210);
    }
  });

  it('a genuine idle gap between two unrelated single waves keeps BOTH at the base delay', async () => {
    vi.useFakeTimers();
    volumeRows.push(row('v-a'));
    installCover('v-a', coverResult('a.webp'));
    await vi.advanceTimersByTimeAsync(COVER_PERSIST_BASE_DELAY_MS);
    expect(transactionSpy).toHaveBeenCalledTimes(1);

    // A long, genuine gap — not sustained arrival.
    await vi.advanceTimersByTimeAsync(30_000);

    volumeRows.push(row('v-b'));
    installCover('v-b', coverResult('b.webp'));
    // If this were still backed off from the first wave, base delay alone
    // would not be enough to flush it yet. It should be, since the gap reset
    // the cadence.
    await vi.advanceTimersByTimeAsync(COVER_PERSIST_BASE_DELAY_MS);
    expect(transactionSpy).toHaveBeenCalledTimes(2);
  });
});

describe('requirement (a): sustained back-to-back arrival backs off, producing far fewer flushes than waves', () => {
  it('~150 waves over 30s of continuous arrival collapse into a handful of flushes, and every wave still lands', async () => {
    vi.useFakeTimers();

    const WAVE_INTERVAL_MS = 200; // far faster than the base 750ms cadence — sustained arrival
    const TOTAL_WAVES = 150; // 150 * 200ms = 30s of continuous arrival

    volumeRows.push(row('v-0'));
    installCover('v-0', coverResult('0.webp')); // arms the very first timer, at base delay

    for (let i = 1; i <= TOTAL_WAVES; i++) {
      await vi.advanceTimersByTimeAsync(WAVE_INTERVAL_MS);
      volumeRows.push(row(`v-${i}`));
      installCover(`v-${i}`, coverResult(`${i}.webp`));
    }
    // Drain whatever the last few waves left queued.
    await vi.advanceTimersByTimeAsync(COVER_PERSIST_MAX_DELAY_MS + 1);

    // 151 waves, but flushes should be FAR fewer — the whole point of the
    // backoff. Worked example: 750+1500+3000+6000+8000×3(ish) ≈ covers the
    // ~30s+drain span in well under 10 flushes.
    expect(transactionSpy.mock.calls.length).toBeGreaterThan(0);
    expect(transactionSpy.mock.calls.length).toBeLessThan(15);
    expect(transactionSpy.mock.calls.length).toBeLessThan(TOTAL_WAVES / 10);

    // Requirement (c): nothing lost — every single wave's cover landed.
    for (let i = 0; i <= TOTAL_WAVES; i++) {
      expect(volumeRows.find((r) => r.volume_uuid === `v-${i}`)?.thumbnail_width).toBe(210);
    }
  });

  it('resets to the base delay once a flush drains with nothing arriving behind it', async () => {
    vi.useFakeTimers();

    // Force a couple of backed-off cycles.
    volumeRows.push(row('v-0'));
    installCover('v-0', coverResult('0.webp'));
    await vi.advanceTimersByTimeAsync(COVER_PERSIST_BASE_DELAY_MS); // flush #1, base delay
    volumeRows.push(row('v-1'));
    installCover('v-1', coverResult('1.webp')); // arrives immediately after — backs off
    await vi.advanceTimersByTimeAsync(COVER_PERSIST_BASE_DELAY_MS * 2); // flush #2, backed-off delay
    expect(transactionSpy).toHaveBeenCalledTimes(2);

    // Now go fully idle for well longer than any backed-off window.
    await vi.advanceTimersByTimeAsync(COVER_PERSIST_MAX_DELAY_MS * 2);

    // A fresh wave should flush at the BASE delay again, not still backed off.
    volumeRows.push(row('v-2'));
    installCover('v-2', coverResult('2.webp'));
    await vi.advanceTimersByTimeAsync(COVER_PERSIST_BASE_DELAY_MS - 1);
    expect(transactionSpy).toHaveBeenCalledTimes(2); // not yet
    await vi.advanceTimersByTimeAsync(1);
    expect(transactionSpy).toHaveBeenCalledTimes(3); // exactly at base delay
  });
});

describe('requirement (c): the backoff only ever defers WHEN a flush happens, never whether', () => {
  it('a direct flushPendingCoverPersists() call still drains everything immediately, bypassing the cadence entirely', async () => {
    const { flushPendingCoverPersists } = await import('./cover-persist');
    volumeRows.push(row('v-x'));
    installCover('v-x', coverResult('x.webp'));

    await flushPendingCoverPersists();

    expect(volumeRows.find((r) => r.volume_uuid === 'v-x')?.thumbnail_width).toBe(210);
  });
});
