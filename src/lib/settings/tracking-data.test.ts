import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import { get } from 'svelte/store';
import {
  TRACKING_SECTION_KEY,
  detectBogusTrackingKeys,
  idleSettings,
  mergeTrackingSections,
  parseTrackingSection,
  setIdleOverride,
  setTrackingStates,
  trackingState
} from './tracking-data';
import { DEFAULT_K } from '$lib/reading-history/stats-engine';

const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-02T00:00:00.000Z';

beforeEach(() => setTrackingStates({}));

describe('parseTrackingSection', () => {
  it('keeps a valid idle entry', () => {
    expect(parseTrackingSection({ idle: { k: 4, override_minutes: 12, lastUpdated: T1 } })).toEqual(
      { idle: { k: 4, override_minutes: 12, lastUpdated: T1 } }
    );
  });

  it('coerces out-of-range values: k into 1–20, an override outside 1–60 to automatic', () => {
    expect(parseTrackingSection({ idle: { k: 99, override_minutes: 0, lastUpdated: T1 } })).toEqual(
      {
        idle: { k: 20, override_minutes: null, lastUpdated: T1 }
      }
    );
    expect(parseTrackingSection({ idle: { k: 'x', lastUpdated: T1 } }).idle?.k).toBeUndefined();
  });

  it('drops junk and unknown keys; an unparsable stamp loses every merge', () => {
    expect(parseTrackingSection('nope')).toEqual({});
    expect(parseTrackingSection({ other: {}, idle: 3 })).toEqual({});
    expect(parseTrackingSection({ idle: { k: 2, lastUpdated: 'never' } }).idle?.lastUpdated).toBe(
      new Date(0).toISOString()
    );
  });

  it('uses the reserved key name', () => {
    expect(TRACKING_SECTION_KEY).toBe('tracking');
  });
});

describe('mergeTrackingSections', () => {
  const local = { idle: { override_minutes: 8, lastUpdated: T1 } };
  const cloud = { idle: { override_minutes: 15, lastUpdated: T2 } };

  it('newest stamp wins per key; a tie keeps local', () => {
    expect(mergeTrackingSections(local, cloud).idle?.override_minutes).toBe(15);
    expect(mergeTrackingSections(cloud, local).idle?.override_minutes).toBe(15);
    expect(
      mergeTrackingSections(local, { idle: { override_minutes: 2, lastUpdated: T1 } }).idle
        ?.override_minutes
    ).toBe(8);
  });

  it('a bogus (future) cloud entry forfeits to local, but is adopted when local has none', () => {
    const bogus = detectBogusTrackingKeys({ idle: { lastUpdated: '2999-01-01T00:00:00.000Z' } });
    expect([...bogus]).toEqual(['idle']);
    expect(mergeTrackingSections(local, cloud, bogus).idle?.override_minutes).toBe(8);
    expect(mergeTrackingSections({}, cloud, bogus).idle?.override_minutes).toBe(15);
  });
});

describe('idle settings', () => {
  it('default to automatic', () => {
    expect(get(idleSettings)).toEqual({ k: DEFAULT_K, overrideMs: null });
  });

  it('follow a manual override and back', () => {
    setIdleOverride(10);
    expect(get(idleSettings).overrideMs).toBe(10 * 60_000);
    setIdleOverride(null);
    expect(get(idleSettings).overrideMs).toBeNull();
  });

  it('stamps an edit past a future stamp already stored, so it wins the next merge', () => {
    setTrackingStates({ idle: { override_minutes: 5, lastUpdated: '2026-12-31T00:00:00.000Z' } });
    setIdleOverride(20);
    expect(get(trackingState).idle!.lastUpdated > '2026-12-31T00:00:00.000Z').toBe(true);
  });

  it('persists locally', () => {
    setIdleOverride(9);
    expect(JSON.parse(window.localStorage.getItem('tracking-data')!).idle.override_minutes).toBe(9);
  });
});
