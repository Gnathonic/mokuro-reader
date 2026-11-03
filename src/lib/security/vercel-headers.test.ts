/**
 * The response headers `vercel.json` adds on Vercel (stage 1 of the security
 * headers; the shell's CSP is SvelteKit's, `csp-policy.js`). `vite preview`
 * does not apply this file, so the e2e spec (`e2e/csp.spec.ts`) re-applies it
 * with the same matching as below; on a real deployment, check with `curl -sI`.
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

describe('vercel.json', () => {
  it('keeps the pinned install command', () => {
    expect(vercel.installCommand).toBe('npm ci');
  });

  it('has exactly the site-wide rule and the worker rule, in shapes the matcher above covers', () => {
    expect(rules.map((r) => r.source)).toEqual([SITE, WORKERS]);
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

  it('sets no Referrer-Policy: the API key referrer restriction needs the origin', () => {
    for (const r of rules) expect(header(r, 'Referrer-Policy')).toBeUndefined();
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
    const [a, b] = rules;
    const shared = a.headers
      .map((h) => h.key.toLowerCase())
      .filter((k) => b.headers.some((h) => h.key.toLowerCase() === k));
    expect(shared).toEqual([]);
    // …and leaves the shell's CSP to SvelteKit, which hashes its inline script.
    expect(header(rule(SITE), 'Content-Security-Policy')).toBeUndefined();
    expect(header(rule(SITE), 'Content-Security-Policy-Report-Only')).toBeUndefined();
  });
});
