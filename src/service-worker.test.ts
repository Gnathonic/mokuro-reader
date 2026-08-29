import { describe, it, expect, vi, beforeAll } from 'vitest';

type FetchHandler = (event: {
  request: Request;
  respondWith: (p: Promise<Response> | Response) => void;
}) => void;

let fetchHandler: FetchHandler;

beforeAll(async () => {
  const listeners = new Map<string, EventListener>();
  vi.spyOn(self, 'addEventListener').mockImplementation(((type: string, cb: EventListener) => {
    listeners.set(type, cb);
  }) as typeof self.addEventListener);

  const cacheStore = new Map<string, Response>();
  const cache = {
    addAll: vi.fn(async () => {}),
    match: vi.fn(async (key: string | Request) => {
      const k = typeof key === 'string' ? key : new URL(key.url).pathname;
      return cacheStore.get(k);
    }),
    put: vi.fn(async (req: Request, res: Response) => {
      cacheStore.set(new URL(req.url).pathname, res);
    })
  };
  vi.stubGlobal('caches', {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true)
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('ok', { status: 200 }))
  );

  // Non-literal specifier: keeps service-worker.js out of the main TS program
  // (SvelteKit excludes it there because it needs the WebWorker lib), while
  // vitest still resolves it relative to this file at runtime.
  const swModule = './service-worker.js';
  await import(/* @vite-ignore */ swModule);
  fetchHandler = listeners.get('fetch') as unknown as FetchHandler;
  expect(fetchHandler).toBeTypeOf('function');
});

function dispatch(url: string, method = 'GET') {
  const respondWith = vi.fn();
  fetchHandler({ request: new Request(url, { method }), respondWith });
  return respondWith;
}

describe('service worker fetch interception', () => {
  it('handles same-origin app asset requests', () => {
    const respondWith = dispatch(`${self.location.origin}/_app/immutable/entry/app.js`);
    expect(respondWith).toHaveBeenCalledTimes(1);
  });

  it('handles same-origin navigation requests', () => {
    const respondWith = dispatch(`${self.location.origin}/`);
    expect(respondWith).toHaveBeenCalledTimes(1);
  });

  // Google Fonts requests are small and fast, and the font files were the one
  // cross-origin resource the offline cache genuinely served — keep them.
  it.each([
    'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&display=swap',
    'https://fonts.gstatic.com/s/notosansjp/v53/abc.woff2'
  ])('still handles allowlisted Google Fonts request %s', (url) => {
    const respondWith = dispatch(url);
    expect(respondWith).toHaveBeenCalledTimes(1);
  });

  it('ignores non-GET requests', () => {
    const respondWith = dispatch(`${self.location.origin}/api/x`, 'POST');
    expect(respondWith).not.toHaveBeenCalled();
  });

  // Cross-origin downloads (external catalogs, Google Drive alt=media, WebDAV,
  // OneDrive, MEGA) must NOT be proxied through the service worker. Firefox
  // terminates an idle service worker ~30s after respondWith() settles, which
  // aborts any response body still streaming through it ("Error in input
  // stream" / "A ServiceWorker intercepted the request and encountered an
  // unexpected error"). Not calling respondWith() lets the browser fetch
  // natively with the SW out of the data path.
  it.each([
    'https://catalog.example.net/manga/Foo/Vol%201.cbz',
    'https://www.googleapis.com/drive/v3/files/abc?alt=media',
    'https://www.googleapis.com/drive/v3/files/abc?fields=size',
    'https://cloud.example.com/remote.php/dav/files/u/manga/v1.cbz',
    'https://graph.microsoft.com/v1.0/me/drive/items/x/content',
    'https://g.api.mega.co.nz/cs'
  ])('does not intercept cross-origin request %s', (url) => {
    const respondWith = dispatch(url);
    expect(respondWith).not.toHaveBeenCalled();
  });
});
