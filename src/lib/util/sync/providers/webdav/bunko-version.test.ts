import { describe, expect, it } from 'vitest';
import { bunkoSupportsHistory, bunkoVersionAtLeast } from './bunko-version';

const PER_USER = ['volume-data.json', 'profiles.json', 'goals.json', 'history/'];

describe('bunkoVersionAtLeast', () => {
  it.each([
    ['0.8.0', [0, 8, 0], true],
    ['0.8.0-beta.1', [0, 8, 0], true],
    ['0.7.9', [0, 8, 0], false],
    ['1.0.0', [0, 8, 0], true],
    ['0.8.0', [0, 8, 1], false],
    ['0.8', [0, 8, 0], false]
  ] as const)('%s >= %j -> %s', (version, min, expected) => {
    expect(bunkoVersionAtLeast(version, min)).toBe(expected);
  });
});

describe('bunkoSupportsHistory', () => {
  it.each(['0.8.0', '0.8.1', '0.9.0', '1.0.0', '0.8.0-beta.1', '0.8.0-rc.2+abc', 'v0.8.0'])(
    '%s with history/ per user keeps history per user',
    (v) => {
      expect(bunkoSupportsHistory(v, PER_USER)).toBe(true);
    }
  );

  it.each([undefined, '', '0.7.1', '0.7.3', '0.7.9', '0.7.9-beta.1', '0.6.9', '0.8', 'garbage'])(
    '%s does not, even listing history/',
    (v) => {
      expect(bunkoSupportsHistory(v, PER_USER)).toBe(false);
    }
  );

  // A build that leaves history out of its per-user set files `history/` into
  // the shared library: the version alone must not open the gate.
  it.each([
    ['not reported', undefined],
    ['empty', []],
    ['without history/', ['volume-data.json', 'profiles.json', 'goals.json']],
    ['naming history without the slash', ['history']]
  ])('0.8.0 with per_user_files %s does not', (_label, perUserFiles) => {
    expect(bunkoSupportsHistory('0.8.0', perUserFiles)).toBe(false);
  });
});
