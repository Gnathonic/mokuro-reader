import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/svelte';
import type { VolumeMetadata } from '$lib/types';

/**
 * The text view waits for `currentVolumeData`, which never resolves for a
 * volume whose OCR is not on this device — so without a state check the page
 * spins forever on a direct link.
 */
const { currentVolume, currentVolumeData } = vi.hoisted(() => {
  function store<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      },
      set(next: T) {
        value = next;
        subs.forEach((fn) => fn(value));
      }
    };
  }
  return {
    currentVolume: store<unknown>(undefined),
    currentVolumeData: store<unknown>(undefined)
  };
});

// The catalog barrel drags in Dexie and the whole sync stack; only these two matter.
vi.mock('$lib/catalog', () => ({ currentVolume, currentVolumeData }));
vi.mock('$lib/util/hash-router', () => ({
  nav: { toReader: vi.fn(), toSeries: vi.fn() },
  routeParams: {
    subscribe: (fn: (v: Record<string, string>) => void) => {
      fn({ volume: 'uuid-1', manga: 'One Piece' });
      return () => {};
    }
  }
}));
vi.mock('$lib/settings/reading-speed', () => ({
  personalizedReadingSpeed: {
    subscribe: (fn: (v: unknown) => void) => {
      fn({ isPersonalized: false, charsPerMinute: 0 });
      return () => {};
    }
  }
}));
vi.mock('$lib/metadata/store', () => ({
  seriesMetadataMap: {
    subscribe: (fn: (v: Map<string, unknown>) => void) => {
      fn(new Map());
      return () => {};
    }
  }
}));

import VolumeTextView from '../VolumeTextView.svelte';

function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'uuid-1',
    series_uuid: 'series-1',
    series_title: 'One Piece',
    volume_title: 'Volume 1',
    mokuro_version: '0.4.11',
    page_count: 200,
    character_count: 5000,
    page_char_counts: [],
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  currentVolume.set(undefined);
  currentVolumeData.set(undefined);
});

describe('VolumeTextView', () => {
  it('says so instead of spinning forever when the volume is not on this device', () => {
    currentVolume.set(volume({ metadata_only: true }));

    render(VolumeTextView);

    expect(screen.getByText('This volume is not on this device.')).toBeTruthy();
    expect(screen.queryByText('Loading volume text...')).toBeNull();
  });

  it('still waits while an installed volume’s data loads', () => {
    currentVolume.set(volume());

    render(VolumeTextView);

    expect(screen.getByText('Loading volume text...')).toBeTruthy();
  });
});
