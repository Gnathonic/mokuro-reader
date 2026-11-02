import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetEscapesForTests,
  newestUploaded,
  noteUploaded,
  unwatchEscapes,
  watchEscapes,
  watchedEscapes
} from './escapes';

describe('escapes', () => {
  beforeEach(() => _resetEscapesForTests());

  it('keeps the newest uploaded stamp of a watched volume', () => {
    watchEscapes('v');
    expect(newestUploaded('v')).toBe(0);
    noteUploaded('v', 2000);
    noteUploaded('v', 1000);
    expect(newestUploaded('v')).toBe(2000);
    expect(watchedEscapes()).toEqual(['v']);
  });

  it('ignores uploads of volumes nobody watches, and forgets on unwatch', () => {
    noteUploaded('v', 2000);
    watchEscapes('v');
    expect(newestUploaded('v')).toBe(0);
    noteUploaded('v', 3000);
    unwatchEscapes('v');
    expect(newestUploaded('v')).toBe(0);
    expect(watchedEscapes()).toEqual([]);
  });

  it('watching again starts from nothing', () => {
    watchEscapes('v');
    noteUploaded('v', 3000);
    watchEscapes('v');
    expect(newestUploaded('v')).toBe(3000); // still the same watch
    unwatchEscapes('v');
    watchEscapes('v');
    expect(newestUploaded('v')).toBe(0);
  });

  it('a non-finite stamp is no upload', () => {
    watchEscapes('v');
    noteUploaded('v', Number.NaN);
    expect(newestUploaded('v')).toBe(0);
  });
});
