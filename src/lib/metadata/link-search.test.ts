import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLinkSearch } from './link-search';
import type { MetadataProvider, MetadataSearchResult } from './provider-interface';
import { AniListError } from './providers/anilist';

const result = (id: number): MetadataSearchResult => ({
  provider: 'anilist',
  id,
  titles: { romaji: `R${id}` },
  synonyms: [],
  siteUrl: `https://anilist.co/manga/${id}`
});

describe('createLinkSearch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeProvider(impl: MetadataProvider['search']): MetadataProvider {
    return { id: 'anilist', search: vi.fn(impl), getById: vi.fn(), siteUrl: (id) => `u${id}` };
  }

  it('debounces and only searches the latest query', async () => {
    const provider = makeProvider(async (q) => [result(q.length)]);
    const onResults = vi.fn();
    const search = createLinkSearch({
      provider,
      debounceMs: 300,
      onResults,
      onError: vi.fn(),
      onLoading: vi.fn()
    });
    search.setQuery('o');
    search.setQuery('on');
    search.setQuery('one');
    await vi.advanceTimersByTimeAsync(299);
    expect(provider.search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(provider.search).toHaveBeenCalledWith('one', expect.any(AbortSignal));
    expect(onResults).toHaveBeenCalledWith([result(3)]);
  });

  it('aborts the in-flight request when a newer query arrives and ignores its result', async () => {
    let firstSignal: AbortSignal | undefined;
    const provider = makeProvider(async (q, signal) => {
      if (q === 'first') {
        firstSignal = signal;
        return new Promise((resolve) => setTimeout(() => resolve([result(1)]), 1000));
      }
      return [result(2)];
    });
    const onResults = vi.fn();
    const search = createLinkSearch({
      provider,
      debounceMs: 0,
      onResults,
      onError: vi.fn(),
      onLoading: vi.fn()
    });
    search.setQuery('first');
    await vi.advanceTimersByTimeAsync(0);
    search.setQuery('second');
    await vi.advanceTimersByTimeAsync(0);
    expect(firstSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onResults).toHaveBeenCalledTimes(1);
    expect(onResults).toHaveBeenCalledWith([result(2)]);
  });

  it('reports rate-limit and network errors as messages, and clears results on blank query', async () => {
    const provider = makeProvider(async () => {
      throw new AniListError('RATE_LIMITED', 'AniList rate limit reached', 5000);
    });
    const onError = vi.fn();
    const onResults = vi.fn();
    const search = createLinkSearch({
      provider,
      debounceMs: 0,
      onResults,
      onError,
      onLoading: vi.fn()
    });
    search.setQuery('x');
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/rate limit/i));
    search.setQuery('   ');
    await vi.advanceTimersByTimeAsync(0);
    expect(onResults).toHaveBeenLastCalledWith([]);
  });
});
