import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetCloudPositionsForTests,
  cloudPositionStamp,
  noteCloudPositions
} from './positions-cloud';

const provider = (type: string, accountScope?: string) => ({
  type,
  getStatus: () => ({ accountScope })
});
const entry = (t: number) => ({ t, page: 1, chars: 0, device: 'd' });

beforeEach(() => _resetCloudPositionsForTests());

describe('the last known cloud positions.json', () => {
  it('answers for the account it was read from', () => {
    const p = provider('webdav', 'https://a/');
    noteCloudPositions(p, { v: entry(5) });
    expect(cloudPositionStamp(p, 'v')).toBe(5);
    expect(cloudPositionStamp(p, 'other')).toBeUndefined();
  });

  it('never for another account or provider type', () => {
    noteCloudPositions(provider('webdav', 'https://a/'), { v: entry(5) });
    expect(cloudPositionStamp(provider('webdav', 'https://b/'), 'v')).toBeUndefined();
    expect(cloudPositionStamp(provider('mega', 'https://a/'), 'v')).toBeUndefined();
  });

  it('a provider that cannot name its account is never vouched for, and forgets the last one', () => {
    noteCloudPositions(provider('webdav', 'https://a/'), { v: entry(5) });
    noteCloudPositions(provider('webdav'), { v: entry(9) });
    expect(cloudPositionStamp(provider('webdav'), 'v')).toBeUndefined();
    expect(cloudPositionStamp(provider('webdav', 'https://a/'), 'v')).toBeUndefined();
  });

  it('a newer read replaces the whole map', () => {
    const p = provider('webdav', 'https://a/');
    noteCloudPositions(p, { v: entry(5), w: entry(6) });
    noteCloudPositions(p, { v: entry(7) });
    expect(cloudPositionStamp(p, 'v')).toBe(7);
    expect(cloudPositionStamp(p, 'w')).toBeUndefined();
  });
});
