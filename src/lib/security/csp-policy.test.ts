import { describe, expect, it } from 'vitest';
import { CSP_NOOP_REPORT_GROUP, cspDirectives, kitCsp, parseCspMode } from './csp-policy.js';
import { GOOGLE_SCRIPT_URLS } from '$lib/util/sync/providers/google-drive/google-scripts';

describe('parseCspMode', () => {
  it('is off when unset or empty', () => {
    expect(parseCspMode(undefined)).toBe('off');
    expect(parseCspMode('')).toBe('off');
    expect(parseCspMode('  ')).toBe('off');
  });

  it('takes each mode, whatever its case and surrounding space', () => {
    expect(parseCspMode('off')).toBe('off');
    expect(parseCspMode('report-only')).toBe('report-only');
    expect(parseCspMode(' ENFORCE ')).toBe('enforce');
  });

  it('fails the build on anything else: a typo must not ship the wrong policy', () => {
    expect(() => parseCspMode('enforced')).toThrow(/CSP_MODE/);
    expect(() => parseCspMode('report_only')).toThrow(/CSP_MODE/);
  });
});

describe('kitCsp', () => {
  it('always uses hashes, never nonces (the shell is cached by the CDN)', () => {
    for (const mode of ['off', 'report-only', 'enforce'] as const) {
      expect(kitCsp(mode).mode).toBe('hash');
    }
  });

  it('off: no policy of either kind', () => {
    const csp = kitCsp('off');
    expect(csp.directives).toBeUndefined();
    expect(csp.reportOnly).toBeUndefined();
  });

  it('enforce: the directives, no report-only policy, no reporting', () => {
    const csp = kitCsp('enforce');
    expect(csp.directives).toEqual(cspDirectives());
    expect(csp.reportOnly).toBeUndefined();
    expect(csp.directives?.['report-uri']).toBeUndefined();
    expect(csp.directives?.['report-to']).toBeUndefined();
  });

  it('report-only: the same directives plus the no-op report-to group kit requires', () => {
    // Without report-to (or report-uri) kit throws while rendering every page.
    const csp = kitCsp('report-only');
    expect(csp.directives).toBeUndefined();
    expect(csp.reportOnly).toEqual({ ...cspDirectives(), 'report-to': [CSP_NOOP_REPORT_GROUP] });
    // Never a report-uri: a same-origin one makes every report a function call.
    expect(csp.reportOnly?.['report-uri']).toBeUndefined();
  });

  it('hands kit fresh arrays each time (kit appends its hashes to them)', () => {
    const a = kitCsp('enforce');
    const b = kitCsp('enforce');
    a.directives?.['script-src']?.push('sha256-x');
    expect(b.directives?.['script-src']).not.toContain('sha256-x');
  });
});

describe('the directives', () => {
  const d = cspDirectives();

  it('allow the Google scripts by exact path, never by bare host', () => {
    const scripts = d['script-src'] ?? [];
    for (const url of GOOGLE_SCRIPT_URLS) expect(scripts).toContain(url);
    // gapi's loader fetches its modules (client, picker) from this prefix.
    expect(scripts).toContain('https://apis.google.com/_/scs/');
    // Both hosts serve JSONP endpoints / AngularJS: allowing the host is a bypass.
    for (const bare of [
      'https://accounts.google.com',
      'accounts.google.com',
      'https://www.gstatic.com',
      'www.gstatic.com',
      'https://apis.google.com',
      'https:',
      '*'
    ]) {
      expect(scripts).not.toContain(bare);
    }
    expect(scripts).not.toContain('unsafe-inline');
    expect(scripts).not.toContain('unsafe-eval');
    expect(scripts).toEqual(['self', 'wasm-unsafe-eval', ...scripts.slice(2)]);
  });

  it('take styles from self and the two Google stylesheets, inline only in attributes', () => {
    expect(d['style-src']).toEqual([
      'self',
      'https://fonts.googleapis.com',
      'https://accounts.google.com/gsi/style'
    ]);
    expect(d['style-src-attr']).toEqual(['unsafe-inline']);
  });

  it('keep plain http open for connections only (loopback AnkiConnect, LAN WebDAV)', () => {
    expect(d['connect-src']).toEqual(['self', 'https:', 'http:', 'data:', 'blob:']);
    expect(d['img-src']).toEqual(['self', 'blob:', 'data:', 'https:']);
    expect(d['font-src']).toEqual(['self', 'https://fonts.gstatic.com', 'data:']);
  });

  it('frame only the Google and Microsoft pages the providers open', () => {
    expect(d['frame-src']).toEqual([
      'self',
      'https://accounts.google.com',
      'https://docs.google.com',
      'https://drive.google.com',
      'https://content.googleapis.com',
      'https://login.microsoftonline.com',
      // MSAL's silent renewal frame redirects a personal account through it.
      'https://login.live.com'
    ]);
  });

  it('lock down the rest', () => {
    // No default: it would refuse the https: media extensions inject (Migaku).
    expect(d['default-src']).toBeUndefined();
    expect(d['media-src']).toBeUndefined();
    // pica's capability probe and zip.js's codec workers are data: URLs.
    expect(d['worker-src']).toEqual(['self', 'blob:', 'data:']);
    expect(d['object-src']).toEqual(['none']);
    expect(d['base-uri']).toEqual(['self']);
    expect(d['form-action']).toEqual(['self']);
    expect(d['frame-ancestors']).toEqual(['self']);
  });

  it('leave out what would break the app: upgrade-insecure-requests, Trusted Types', () => {
    expect(d['upgrade-insecure-requests']).toBeUndefined();
    expect(d['require-trusted-types-for']).toBeUndefined();
    expect(d['trusted-types']).toBeUndefined();
  });
});
