import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import { get } from 'svelte/store';
import {
  DEVICE_NAME_MAX,
  TRACKING_SECTION_KEY,
  detectBogusTrackingKeys,
  deviceLabels,
  foldableTracking,
  idleSettings,
  mergeDevice,
  mergeDeviceLabels,
  mergeTrackingSections,
  parseTrackingSection,
  pauseDefault,
  renameDevice,
  resetIdleK,
  setDeviceClass,
  setIdleOverride,
  setPauseDefault,
  setTrackingStates,
  trackingState,
  unmergeDevice,
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

const FUTURE = '2999-01-01T00:00:00.000Z';

describe('tracking.devices: parse', () => {
  it('keeps a valid label, name trimmed', () => {
    expect(
      parseTrackingSection({
        devices: {
          'dev-a': { name: '  Pixel 8 ', class: 'phone', merged_into: 'dev-b', lastUpdated: T1 }
        }
      })
    ).toEqual({
      devices: {
        'dev-a': { name: 'Pixel 8', class: 'phone', merged_into: 'dev-b', lastUpdated: T1 }
      }
    });
  });

  it('drops ids that are not device ids and values that are not records', () => {
    expect(
      parseTrackingSection({
        devices: {
          'legacy:vol-1': { name: 'Old', lastUpdated: T1 },
          'a/b': { name: 'Slash', lastUpdated: T1 },
          ['x'.repeat(65)]: { name: 'Long', lastUpdated: T1 },
          'dev-a': 'Pixel',
          'dev-b': { name: 'Kept', lastUpdated: T1 }
        }
      })
    ).toEqual({ devices: { 'dev-b': { name: 'Kept', lastUpdated: T1 } } });
  });

  it('omits devices when nothing valid is left, and never takes another key with it', () => {
    expect(parseTrackingSection({ devices: { 'legacy:vol-1': { lastUpdated: T1 } } })).toEqual({});
    expect(
      parseTrackingSection({ devices: ['dev-a'], pauses: { default: 'full', lastUpdated: T1 } })
    ).toEqual({ pauses: { default: 'full', lastUpdated: T1 } });
  });

  it('drops invalid fields one by one and keeps a stamp-only entry', () => {
    const parsed = parseTrackingSection({
      devices: {
        'dev-a': { name: 42, class: 'watch', merged_into: 'dev-a', lastUpdated: T1 },
        'dev-b': { name: '   ', merged_into: 'legacy:vol-1', lastUpdated: T1 },
        'dev-c': { merged_into: 7, lastUpdated: T1 }
      }
    });
    expect(parsed.devices).toEqual({
      'dev-a': { lastUpdated: T1 },
      'dev-b': { lastUpdated: T1 },
      'dev-c': { lastUpdated: T1 }
    });
  });

  it('cuts a name longer than DEVICE_NAME_MAX characters (code points, not UTF-16 units)', () => {
    const parsed = parseTrackingSection({
      devices: { 'dev-a': { name: 'あ'.repeat(50), lastUpdated: T1 } }
    });
    expect(DEVICE_NAME_MAX).toBe(40);
    expect(parsed.devices?.['dev-a'].name).toBe('あ'.repeat(40));
  });

  it('an unparsable stamp loses every merge; a future one is clamped on read', () => {
    const parsed = parseTrackingSection({
      devices: { 'dev-a': { name: 'A' }, 'dev-b': { name: 'B', lastUpdated: FUTURE } }
    });
    expect(parsed.devices?.['dev-a'].lastUpdated).toBe(new Date(0).toISOString());
    expect(parsed.devices!['dev-b'].lastUpdated < FUTURE).toBe(true);
  });
});

describe('tracking.devices: bogus stamps', () => {
  it('names a future device stamp devices/<id>, beside the plain keys', () => {
    const bogus = detectBogusTrackingKeys({
      idle: { override_minutes: 5, lastUpdated: FUTURE },
      devices: {
        'dev-a': { name: 'A', lastUpdated: FUTURE },
        'dev-b': { name: 'B', lastUpdated: T1 },
        'legacy:vol-1': { lastUpdated: FUTURE }
      }
    });
    expect([...bogus].sort()).toEqual(['devices/dev-a', 'idle']);
  });

  it('never flags the devices map itself', () => {
    expect([...detectBogusTrackingKeys({ devices: { lastUpdated: FUTURE } })]).toEqual([]);
  });
});

describe('tracking.devices: merge', () => {
  it('merges per device id: newest wins, a tie keeps local, a missing one is adopted', () => {
    const merged = mergeDeviceLabels(
      {
        'dev-a': { name: 'Old', lastUpdated: T1 },
        'dev-b': { name: 'Mine', lastUpdated: T2 },
        'dev-d': { name: 'Tie local', lastUpdated: T1 }
      },
      {
        'dev-a': { name: 'New', lastUpdated: T2 },
        'dev-b': { name: 'Theirs', lastUpdated: T1 },
        'dev-c': { name: 'Third', lastUpdated: T1 },
        'dev-d': { name: 'Tie cloud', lastUpdated: T1 }
      }
    );
    expect(merged).toEqual({
      'dev-a': { name: 'New', lastUpdated: T2 },
      'dev-b': { name: 'Mine', lastUpdated: T2 },
      'dev-c': { name: 'Third', lastUpdated: T1 },
      'dev-d': { name: 'Tie local', lastUpdated: T1 }
    });
  });

  it('a bogus cloud label forfeits to local, but is adopted when local has none', () => {
    const raw = { devices: { 'dev-a': { name: 'Junk', lastUpdated: FUTURE } } };
    const bogus = detectBogusTrackingKeys(raw);
    const cloud = parseTrackingSection(raw);
    const local = { devices: { 'dev-a': { name: 'Mine', lastUpdated: T1 } } };
    expect(mergeTrackingSections(local, cloud, bogus).devices?.['dev-a'].name).toBe('Mine');
    expect(mergeTrackingSections({}, cloud, bogus).devices?.['dev-a'].name).toBe('Junk');
  });

  it('merges devices beside idle; a bogus idle never touches a device label', () => {
    const raw = {
      idle: { override_minutes: 3, lastUpdated: FUTURE },
      devices: { 'dev-a': { name: 'Newer', lastUpdated: T2 } }
    };
    const merged = mergeTrackingSections(
      {
        idle: { override_minutes: 8, lastUpdated: T1 },
        devices: { 'dev-a': { name: 'Older', lastUpdated: T1 } }
      },
      parseTrackingSection(raw),
      detectBogusTrackingKeys(raw)
    );
    expect(merged.idle?.override_minutes).toBe(8);
    expect(merged.devices).toEqual({ 'dev-a': { name: 'Newer', lastUpdated: T2 } });
  });

  it('a newer stamp-only entry (a cleared name) beats an older name', () => {
    const merged = mergeTrackingSections(
      { devices: { 'dev-a': { name: 'Pixel', lastUpdated: T1 } } },
      { devices: { 'dev-a': { lastUpdated: T2 } } }
    );
    expect(merged.devices).toEqual({ 'dev-a': { lastUpdated: T2 } });
  });

  it('adds no devices key when neither side has labels', () => {
    const merged = mergeTrackingSections(
      { idle: { k: 2, lastUpdated: T1 } },
      { pauses: { default: 'none', lastUpdated: T1 } }
    );
    expect('devices' in merged).toBe(false);
  });
});

describe('foldableTracking (duplicate volume-data.json copies)', () => {
  it("drops a copy's bogus device label only when another copy holds that id honestly", () => {
    const poisonedRaw = {
      devices: {
        'dev-a': { name: 'Junk', lastUpdated: FUTURE },
        'dev-b': { name: 'Kept', lastUpdated: T1 },
        'dev-c': { name: 'Only here', lastUpdated: FUTURE }
      }
    };
    const honestRaw = { devices: { 'dev-a': { name: 'Honest', lastUpdated: T1 } } };
    const copies = [poisonedRaw, honestRaw].map((raw) => ({
      tracking: parseTrackingSection(raw),
      bogus: detectBogusTrackingKeys(raw)
    }));
    expect(Object.keys(foldableTracking(copies, 0).devices ?? {}).sort()).toEqual([
      'dev-b',
      'dev-c'
    ]);
    expect(foldableTracking(copies, 1)).toEqual(honestRaw);
  });

  it('still folds idle and pauses per key', () => {
    const copies = [
      {
        tracking: {
          idle: { k: 9, lastUpdated: T2 },
          pauses: { default: 'full' as const, lastUpdated: T1 }
        },
        bogus: new Set(['idle'])
      },
      { tracking: { idle: { k: 2, lastUpdated: T1 } }, bogus: new Set<string>() }
    ];
    expect(foldableTracking(copies, 0)).toEqual({
      pauses: { default: 'full', lastUpdated: T1 }
    });
    expect(foldableTracking(copies, 1)).toEqual({ idle: { k: 2, lastUpdated: T1 } });
  });
});

describe('device label setters', () => {
  it('renames: trimmed, stamped, persisted, and readable through deviceLabels', () => {
    expect(get(deviceLabels)).toEqual({});
    renameDevice('dev-a', '  Pixel 8  ');
    const label = get(trackingState).devices!['dev-a'];
    expect(label.name).toBe('Pixel 8');
    expect(get(deviceLabels)['dev-a'].name).toBe('Pixel 8');
    const stored = JSON.parse(window.localStorage.getItem('tracking-data')!);
    expect(stored.devices['dev-a'].name).toBe('Pixel 8');
    expect(parseTrackingSection(stored)).toEqual(get(trackingState));
  });

  it('an empty name removes the field under a newer stamp, which wins the next merge', () => {
    const named = {
      devices: { 'dev-a': { name: 'Pixel', class: 'phone' as const, lastUpdated: T1 } }
    };
    setTrackingStates(named);
    renameDevice('dev-a', '   ');
    const cleared = get(trackingState).devices!['dev-a'];
    expect(cleared).not.toHaveProperty('name');
    expect(cleared.class).toBe('phone');
    expect(mergeTrackingSections(named, get(trackingState)).devices?.['dev-a']).toEqual(cleared);
  });

  it('caps a long name and ignores ids that are not device ids', () => {
    renameDevice('dev-a', 'x'.repeat(60));
    expect(get(trackingState).devices!['dev-a'].name).toHaveLength(DEVICE_NAME_MAX);
    renameDevice('legacy:vol-1', 'Nope');
    setDeviceClass('legacy:vol-1', 'phone');
    expect(Object.keys(get(trackingState).devices!)).toEqual(['dev-a']);
  });

  it('sets a class and goes back to Automatic with null, keeping the name', () => {
    renameDevice('dev-a', 'Work');
    setDeviceClass('dev-a', 'laptop');
    expect(get(trackingState).devices!['dev-a']).toMatchObject({ name: 'Work', class: 'laptop' });
    setDeviceClass('dev-a', null);
    expect(get(trackingState).devices!['dev-a']).not.toHaveProperty('class');
    expect(get(trackingState).devices!['dev-a'].name).toBe('Work');
  });

  it('stamps past a future stamp already stored, and never touches idle', () => {
    setTrackingStates({
      idle: { k: 4, lastUpdated: T1 },
      devices: { 'dev-a': { name: 'A', lastUpdated: '2026-12-31T00:00:00.000Z' } }
    });
    renameDevice('dev-a', 'B');
    expect(get(trackingState).devices!['dev-a'].lastUpdated > '2026-12-31T00:00:00.000Z').toBe(
      true
    );
    expect(get(trackingState).idle).toEqual({ k: 4, lastUpdated: T1 });
  });

  it('merges into the canonical target, flattening a chain, and keeps the name', () => {
    setTrackingStates({
      devices: {
        'dev-a': { name: 'Old phone', lastUpdated: T1 },
        'dev-b': { merged_into: 'dev-c', lastUpdated: T1 }
      }
    });
    expect(mergeDevice('dev-a', 'dev-b')).toBe(true);
    expect(get(trackingState).devices!['dev-a']).toMatchObject({
      name: 'Old phone',
      merged_into: 'dev-c'
    });
    expect(get(trackingState).devices!['dev-a'].lastUpdated > T1).toBe(true);
  });

  it('refuses a merge into itself, into its own group, or between non-device ids', () => {
    setTrackingStates({ devices: { 'dev-a': { merged_into: 'dev-b', lastUpdated: T1 } } });
    const before = get(trackingState);
    expect(mergeDevice('dev-b', 'dev-b')).toBe(false);
    expect(mergeDevice('dev-b', 'dev-a')).toBe(false);
    expect(mergeDevice('legacy:vol-1', 'dev-b')).toBe(false);
    expect(mergeDevice('dev-c', 'legacy:vol-1')).toBe(false);
    expect(get(trackingState)).toBe(before);
  });

  it('refuses a merge that would join an existing cycle', () => {
    // A cycle from two devices merging concurrently (A→B here, B→A there).
    setTrackingStates({
      devices: {
        'dev-a': { merged_into: 'dev-b', lastUpdated: T1 },
        'dev-b': { merged_into: 'dev-a', lastUpdated: T1 }
      }
    });
    expect(mergeDevice('dev-b', 'dev-a')).toBe(false);
    expect(mergeDevice('dev-c', 'dev-a')).toBe(true);
  });

  it('unmerges under a newer stamp, which beats the merged entry in the next merge', () => {
    const merged = { devices: { 'dev-a': { name: 'Tab', merged_into: 'dev-b', lastUpdated: T1 } } };
    setTrackingStates(merged);
    unmergeDevice('dev-a');
    const label = get(trackingState).devices!['dev-a'];
    expect(label).toEqual({ name: 'Tab', lastUpdated: label.lastUpdated });
    expect(label.lastUpdated > T1).toBe(true);
    expect(mergeTrackingSections(merged, get(trackingState)).devices?.['dev-a']).toEqual(label);
  });

  it('unmerge writes nothing when the device is not merged', () => {
    setTrackingStates({ devices: { 'dev-a': { name: 'A', lastUpdated: T1 } } });
    const before = get(trackingState);
    unmergeDevice('dev-a');
    unmergeDevice('dev-z');
    expect(get(trackingState)).toBe(before);
  });
});

describe('device ids that name an inherited Object key', () => {
  it('adopts a cloud label for "constructor" and never reads Object.prototype', () => {
    const label = { name: 'Odd id', lastUpdated: T1 };
    expect(mergeDeviceLabels({}, { constructor: label })).toEqual({ constructor: label });
    const before = get(trackingState);
    unmergeDevice('constructor');
    expect(get(trackingState)).toBe(before);
    expect(mergeDevice('constructor', 'dev-b')).toBe(true);
    expect(get(trackingState).devices?.constructor).toMatchObject({ merged_into: 'dev-b' });
  });
});
