import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import { get } from 'svelte/store';
import {
  TRACKING_SECTION_KEY,
  detectBogusTrackingKeys,
  idleSettings,
  mergeTrackingSections,
  parseTrackingSection,
  pauseDefault,
  resetIdleK,
  setIdleOverride,
  setPauseDefault,
  setTrackingStates,
  trackingState,
  widenIdleK
} from './tracking-data';
import { DEFAULT_K, K_MAX } from '$lib/reading-history/stats-engine';

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

  it('keeps a pauses entry without an idle one', () => {
    expect(parseTrackingSection({ pauses: { default: 'typical', lastUpdated: T1 } })).toEqual({
      pauses: { default: 'typical', lastUpdated: T1 }
    });
  });

  it('parses each key on its own: a junk one never takes the other with it', () => {
    expect(parseTrackingSection({ idle: 3, pauses: { default: 'none', lastUpdated: T1 } })).toEqual(
      {
        pauses: { default: 'none', lastUpdated: T1 }
      }
    );
    expect(parseTrackingSection({ idle: { k: 2, lastUpdated: T1 }, pauses: 'full' })).toEqual({
      idle: { k: 2, lastUpdated: T1 }
    });
  });

  it('reads a junk or missing standing default as "ask"', () => {
    expect(parseTrackingSection({ pauses: { default: 'sometimes', lastUpdated: T1 } })).toEqual({
      pauses: { default: null, lastUpdated: T1 }
    });
    expect(parseTrackingSection({ pauses: { lastUpdated: T1 } }).pauses?.default).toBeNull();
    expect(parseTrackingSection({ pauses: { default: 'full' } }).pauses?.lastUpdated).toBe(
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

  it('merges pauses and idle apart: each key keeps its own newest stamp', () => {
    const merged = mergeTrackingSections(
      {
        idle: { override_minutes: 8, lastUpdated: T2 },
        pauses: { default: 'full', lastUpdated: T1 }
      },
      {
        idle: { override_minutes: 15, lastUpdated: T1 },
        pauses: { default: 'none', lastUpdated: T2 }
      }
    );
    expect(merged).toEqual({
      idle: { override_minutes: 8, lastUpdated: T2 },
      pauses: { default: 'none', lastUpdated: T2 }
    });
  });

  it('a bogus pauses stamp forfeits only that key', () => {
    const raw = {
      idle: { override_minutes: 15, lastUpdated: T2 },
      pauses: { default: 'none', lastUpdated: '2999-01-01T00:00:00.000Z' }
    };
    const bogus = detectBogusTrackingKeys(raw);
    expect([...bogus]).toEqual(['pauses']);
    const merged = mergeTrackingSections(
      {
        idle: { override_minutes: 8, lastUpdated: T1 },
        pauses: { default: 'full', lastUpdated: T1 }
      },
      parseTrackingSection(raw),
      bogus
    );
    expect(merged.idle?.override_minutes).toBe(15);
    expect(merged.pauses?.default).toBe('full');
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

describe('widening k', () => {
  it('sets k and keeps the manual override (they share one entry and one stamp)', () => {
    setTrackingStates({ idle: { override_minutes: 7, lastUpdated: T1 } });
    widenIdleK(6.5);
    const idle = get(trackingState).idle!;
    expect(idle).toMatchObject({ k: 6.5, override_minutes: 7 });
    expect(idle.lastUpdated > T1).toBe(true);
    expect(get(idleSettings)).toEqual({ k: 6.5, overrideMs: 7 * 60_000 });
  });

  it('clamps k into 1–K_MAX and ignores a non-number', () => {
    widenIdleK(99);
    expect(get(trackingState).idle?.k).toBe(K_MAX);
    widenIdleK(0.2);
    expect(get(trackingState).idle?.k).toBe(1);
    widenIdleK(Number.NaN);
    expect(get(trackingState).idle?.k).toBe(1);
  });

  it('reset writes the default explicitly, so it beats the older widen in a merge', () => {
    const widened = { idle: { k: 9, override_minutes: 4, lastUpdated: T1 } };
    setTrackingStates(widened);
    resetIdleK();
    expect(get(trackingState).idle).toMatchObject({ k: DEFAULT_K, override_minutes: 4 });
    expect(mergeTrackingSections(get(trackingState), widened).idle?.k).toBe(DEFAULT_K);
    expect(get(idleSettings).k).toBe(DEFAULT_K);
  });
});

describe('the standing pause default', () => {
  it('is "ask" until set, then follows the setting back to "ask"', () => {
    expect(get(pauseDefault)).toBeNull();
    setPauseDefault('typical');
    expect(get(pauseDefault)).toBe('typical');
    setPauseDefault(null);
    expect(get(pauseDefault)).toBeNull();
    // "Ask" is an explicit choice, so it beats an older default from another device.
    expect(get(trackingState).pauses?.default).toBeNull();
  });

  it('never touches the idle entry', () => {
    setTrackingStates({ idle: { k: 4, lastUpdated: T1 } });
    setPauseDefault('none');
    expect(get(trackingState).idle).toEqual({ k: 4, lastUpdated: T1 });
  });

  it('stamps past a future stamp already stored', () => {
    setTrackingStates({ pauses: { default: 'full', lastUpdated: '2026-12-31T00:00:00.000Z' } });
    setPauseDefault(null);
    expect(get(trackingState).pauses!.lastUpdated > '2026-12-31T00:00:00.000Z').toBe(true);
  });

  it('survives its own wire format and persists locally', () => {
    setPauseDefault('full');
    widenIdleK(5);
    const stored = JSON.parse(window.localStorage.getItem('tracking-data')!);
    expect(stored.pauses.default).toBe('full');
    expect(parseTrackingSection(stored)).toEqual(get(trackingState));
  });
});
