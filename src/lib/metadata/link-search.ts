import type { MetadataProvider, MetadataSearchResult } from './provider-interface';
import { AniListError } from './providers/anilist';

export interface LinkSearchOptions {
  provider: MetadataProvider;
  debounceMs?: number;
  onResults: (results: MetadataSearchResult[]) => void;
  onError: (message: string) => void;
  onLoading: (loading: boolean) => void;
}

export function describeSearchError(error: unknown): string {
  if (error instanceof AniListError) {
    switch (error.code) {
      case 'RATE_LIMITED': {
        const sec = Math.max(1, Math.ceil((error.retryAfterMs ?? 60000) / 1000));
        return `AniList rate limit reached — try again in ${sec}s`;
      }
      case 'NETWORK':
        return 'Could not reach AniList. Check your connection.';
      case 'UNAUTHORIZED':
        return 'AniList rejected the request.';
      default:
        return error.message;
    }
  }
  return 'Search failed.';
}

/** Debounced, abortable search: only the latest query's results are delivered. */
export function createLinkSearch(opts: LinkSearchOptions) {
  const debounceMs = opts.debounceMs ?? 300;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let seq = 0;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  }

  async function run(query: string) {
    const mySeq = ++seq;
    controller?.abort();
    const myController = new AbortController();
    controller = myController;
    opts.onLoading(true);
    try {
      const results = await opts.provider.search(query, myController.signal);
      if (mySeq !== seq || myController.signal.aborted) return;
      opts.onResults(results);
    } catch (error) {
      if (mySeq !== seq || myController.signal.aborted) return;
      opts.onError(describeSearchError(error));
    } finally {
      if (mySeq === seq) opts.onLoading(false);
    }
  }

  function setQuery(query: string) {
    if (timer) clearTimeout(timer);
    const q = query.trim();
    if (!q) {
      seq++;
      controller?.abort();
      controller = null;
      opts.onLoading(false);
      opts.onResults([]);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void run(q);
    }, debounceMs);
  }

  return { setQuery, cancel };
}
