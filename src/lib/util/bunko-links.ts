/**
 * mokuro-bunko behind a reverse proxy that serves it under a sub-path
 * (`https://example.com/manga/` with the proxy stripping `/manga`) believes
 * it is mounted at `/`: every link it hands out — the manifest named by a
 * PUT's `X-Mokuro-Manifest`, the queue file's `manifest`, a manifest's file
 * URLs — is root-absolute (`/catalog/api/manifest?…`, `/mokuro-reader/S/V.cbz`).
 * Resolved against the server's URL as-is, those miss the prefix and 404.
 *
 * Every bunko route lives under one of these roots, so the prefix is whatever
 * precedes the first of them in a URL known to be the server's own (the
 * WebDAV upload URL, the queue file, a manifest URL). A root-mounted server
 * has none, and nothing changes.
 */
const BUNKO_ROOTS = ['/mokuro-reader', '/catalog', '/login'];

/** `/manga` for `https://example.com/manga/mokuro-reader/S/V.cbz`; '' when mounted at `/`. */
export function bunkoPathPrefix(serverUrl: string): string {
  let path: string;
  try {
    path = new URL(serverUrl).pathname;
  } catch {
    return '';
  }
  let cut = -1;
  for (const root of BUNKO_ROOTS) {
    for (let at = path.indexOf(root); at !== -1; at = path.indexOf(root, at + 1)) {
      const end = at + root.length;
      if (end === path.length || path[end] === '/') {
        if (cut === -1 || at < cut) cut = at;
        break;
      }
    }
  }
  return cut > 0 ? path.slice(0, cut) : '';
}

/**
 * `new URL(link, base)`, with a root-absolute link put back under the prefix
 * `base` is served from. A link already under it (a proxy-aware server) and
 * every other link resolve exactly as `new URL` would. Throws as `new URL` does.
 */
export function resolveBunkoLink(link: string, base: string): string {
  const prefix = bunkoPathPrefix(base);
  if (prefix && link.startsWith('/') && !link.startsWith('//')) {
    if (link !== prefix && !link.startsWith(`${prefix}/`)) {
      return new URL(`${prefix}${link}`, base).toString();
    }
  }
  return new URL(link, base).toString();
}
