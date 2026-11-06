/**
 * The response headers `vercel.json` adds on Vercel (stage 1 of the security
 * headers; the shell's CSP is SvelteKit's, `csp-policy.js`), and the Drive auth
 * backend's own rules for `/oauth/` and `/api/` (their exact values are also
 * pinned in `src/build-config.test.ts`). `vite preview` does not apply this
 * file, so the e2e spec (`e2e/csp.spec.ts`) re-applies it with the same
 * matching as below; on a real deployment, check with `curl -sI`.
 */
import { describe, expect, it } from 'vitest';
import vercel from '../../../vercel.json';

interface Rule {
  source: string;
  headers: { key: string; value: string }[];
}
const rules = (vercel as { headers: Rule[] }).headers;

/**
 * Vercel matches `source` with path-to-regexp. Both sources here are literal
 * path text plus raw regex groups — no named parameters, no `.`, `+` or `?`
 * outside a group — and for that shape path-to-regexp's regexp is the source
 * itself, anchored.
 */
const matches = (rule: Rule, path: string) => new RegExp(`^${rule.source}$`).test(path);

function rule(source: string): Rule {
  const found = rules.find((r) => r.source === source);
  expect(found, `a rule for ${source}`).toBeTruthy();
  return found!;
}
const header = (r: Rule, key: string) =>
  r.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

const SITE = '/((?!api/|oauth/).*)';
const WORKERS = '/_app/immutable/workers/(.*)';
const OAUTH = '/oauth/(.*)';
const API = '/api/(.*)';

/** Paths of every kind the rules tell apart. */
const SAMPLE_PATHS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/_app/immutable/chunks/a.js',
  '/_app/immutable/workers/unified-file-worker-abc.js',
  '/apis',
  '/oauthx',
  '/api/gdrive/refresh',
  '/api/gdrive/session',
  '/oauth/google-callback.html',
  '/oauth/google-callback.js'
];

/** Every header the matching rules send for `path`, by lower-cased name, as lists. */
function headersAt(path: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rules.filter((rule) => matches(rule, path))) {
    for (const h of r.headers) {
      const key = h.key.toLowerCase();
      out.set(key, [...(out.get(key) ?? []), h.value]);
    }
  }
  return out;
}

describe('vercel.json', () => {
  it('keeps the pinned install command', () => {
    expect(vercel.installCommand).toBe('npm ci');
  });

  it('has exactly the site-wide, worker, OAuth-callback and API rules, in shapes the matcher above covers', () => {
    expect(rules.map((r) => r.source)).toEqual([SITE, WORKERS, OAUTH, API]);
    for (const r of rules) {
      // Literal path text, then ONE raw group to the end: nothing outside the
      // group that path-to-regexp would read as syntax.
      expect(r.source).toMatch(/^\/[A-Za-z_/-]*\(.*\)$/);
    }
  });

  it('applies the site-wide headers everywhere but /api/ and /oauth/, which have their own rules', () => {
    const site = rule(SITE);
    for (const path of [
      '/',
      '/index.html',
      '/manifest.json',
      '/_app/immutable/chunks/a.js',
      '/apis',
      '/oauthx'
    ])
      expect(matches(site, path), path).toBe(true);
    for (const path of ['/api/', '/api/anything', '/oauth/', '/oauth/google-callback.html'])
      expect(matches(site, path), path).toBe(false);
    // …which match their own rules, and nothing else does.
    for (const path of SAMPLE_PATHS) {
      expect(matches(rule(OAUTH), path), path).toBe(path.startsWith('/oauth/'));
      expect(matches(rule(API), path), path).toBe(path.startsWith('/api/'));
    }
  });

  it('sends nosniff and a framing refusal on every path, the excluded ones included', () => {
    for (const path of SAMPLE_PATHS) {
      const at = headersAt(path);
      expect(at.get('x-content-type-options'), path).toEqual(['nosniff']);
      const framing =
        at.has('x-frame-options') ||
        /frame-ancestors/.test(at.get('content-security-policy')?.[0] ?? '');
      expect(framing, path).toBe(true);
    }
  });

  it('gives the OAuth callback page an enforced CSP that allows only its own script', () => {
    // google-callback.html loads /oauth/google-callback.js and nothing else:
    // no inline script, no style, no fetch, no frame, no form.
    const oauth = rule(OAUTH);
    expect(header(oauth, 'Content-Security-Policy')).toBe(
      "default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    expect(header(oauth, 'Content-Security-Policy-Report-Only')).toBeUndefined();
    expect(header(oauth, 'X-Frame-Options')).toBe('DENY');
    // Its URL carries the authorization code: no Referer, no cache, no index.
    expect(header(oauth, 'Referrer-Policy')).toBe('no-referrer');
    expect(header(oauth, 'Cache-Control')).toBe('no-store');
    expect(header(oauth, 'X-Robots-Tag')).toBe('noindex');
  });

  it('gives the auth API nothing to render, frame or cache', () => {
    const api = rule(API);
    expect(header(api, 'Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'"
    );
    expect(header(api, 'Cache-Control')).toBe('no-store');
    expect(header(api, 'Referrer-Policy')).toBe('no-referrer');
  });

  it('sends nosniff, SAMEORIGIN framing and a popup-friendly opener policy', () => {
    const site = rule(SITE);
    expect(header(site, 'X-Content-Type-Options')).toBe('nosniff');
    expect(header(site, 'X-Frame-Options')).toBe('SAMEORIGIN');
    // Never `same-origin`: it severs the GIS sign-in popup from the page.
    expect(header(site, 'Cross-Origin-Opener-Policy')).toBe('same-origin-allow-popups');
  });

  it('denies the device features the app never uses, and none it does', () => {
    const policy = header(rule(SITE), 'Permissions-Policy') ?? '';
    const denied = policy.split(',').map((p) => p.trim());
    expect(denied.every((p) => /^[a-z-]+=\(\)$/.test(p))).toBe(true);
    expect(denied.map((p) => p.replace('=()', '')).sort()).toEqual(
      [
        'accelerometer',
        'bluetooth',
        'browsing-topics',
        'camera',
        'geolocation',
        'gyroscope',
        'magnetometer',
        'payment',
        'serial',
        'usb'
      ].sort()
    );
    // Migaku records audio; copy, fullscreen, wake lock, share and the
    // loopback/LAN AnkiConnect and WebDAV requests must keep working.
    for (const kept of [
      'microphone',
      'clipboard-write',
      'fullscreen',
      'screen-wake-lock',
      'web-share',
      'local-network-access',
      'loopback-network'
    ]) {
      expect(policy).not.toContain(kept);
    }
  });

  it('sets no Referrer-Policy on the app: the API key referrer restriction needs the origin', () => {
    // Only the OAuth callback and the auth API send `no-referrer`: neither
    // makes a request the Drive API key's referrer restriction applies to.
    for (const path of SAMPLE_PATHS) {
      const policy = headersAt(path).get('referrer-policy');
      if (path.startsWith('/oauth/') || path.startsWith('/api/'))
        expect(policy, path).toEqual(['no-referrer']);
      else expect(policy, path).toBeUndefined();
    }
  });

  it('gives the module workers their own CSP (they do not inherit the page’s)', () => {
    const workers = rule(WORKERS);
    expect(matches(workers, '/_app/immutable/workers/unified-file-worker-abc.js')).toBe(true);
    expect(matches(workers, '/_app/immutable/chunks/a.js')).toBe(false);
    expect(header(workers, 'Content-Security-Policy')).toBe(
      "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob: data:; object-src 'none'"
    );
  });

  it('never sets one header name from two rules that can match the same path', () => {
    for (const path of SAMPLE_PATHS) {
      const twice = [...headersAt(path)].filter(([, values]) => values.length > 1);
      expect(twice, path).toEqual([]);
    }
    // …and leaves the shell's CSP to SvelteKit, which hashes its inline script.
    expect(header(rule(SITE), 'Content-Security-Policy')).toBeUndefined();
    expect(header(rule(SITE), 'Content-Security-Policy-Report-Only')).toBeUndefined();
  });
});
