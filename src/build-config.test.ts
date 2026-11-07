/**
 * The build and dev-server settings that keep a deploy reproducible and the
 * dev server off the LAN. Each is a one-line config change that a later edit
 * can silently undo, so they are pinned here.
 */
import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import vercel from '../vercel.json';
import lockText from '../package-lock.json?raw';
// As text: importing vite.config.ts would start SvelteKit's plugin under jsdom.
import viteConfig from '../vite.config.ts?raw';
import hooksClient from './hooks.client.ts?raw';

const lock = JSON.parse(lockText);
const devDependencies: Record<string, string | undefined> = pkg.devDependencies;

describe('production build', () => {
  it('fails when a cloud test hook or a server secret reaches the bundle, or the worker cannot install', () => {
    expect(pkg.scripts.build).toBe(
      'vite build && node scripts/check-no-test-hooks.mjs && node scripts/check-no-server-secrets.mjs && node scripts/check-service-worker.mjs'
    );
  });

  it('registers the service worker itself, never through SvelteKit', () => {
    // SvelteKit 3 registers its worker as `{ type: 'module' }` in every build,
    // which a browser without module service workers rejects. The app does it,
    // classic in production (src/lib/util/sw-register.ts).
    expect(viteConfig).toMatch(/serviceWorker:\s*\{\s*register:\s*false\s*\}/);
    expect(hooksClient).toMatch(/^registerServiceWorker\(\);$/m);
  });

  it('uses the lockfile-pinned Vercel adapter, never adapter-auto', () => {
    // adapter-auto installs adapter-vercel at build time, outside the lockfile.
    expect(devDependencies['@sveltejs/adapter-auto']).toBeUndefined();
    // adapter-vercel 7 is the major for SvelteKit 3 (it peers on kit ^3).
    expect(devDependencies['@sveltejs/adapter-vercel']).toMatch(/^\^7\./);
    expect(lock.packages['node_modules/@sveltejs/adapter-vercel']?.version).toMatch(/^7\./);
    expect(lock.packages['node_modules/@sveltejs/kit']?.version).toMatch(/^3\./);
    expect(lock.packages['node_modules/@sveltejs/adapter-auto']).toBeUndefined();

    // Configured in the sveltekit() Vite plugin: SvelteKit 3 reads no svelte.config.js.
    expect(viteConfig).toContain("from '@sveltejs/adapter-vercel'");
    // Without an explicit runtime the adapter derives one from the build
    // machine's Node and throws on any major Vercel does not run.
    expect(viteConfig).toMatch(/adapter\(\{\s*runtime:\s*'nodejs24\.x'\s*\}\)/);
  });

  it('overrides one peer only: @vercel/analytics on SvelteKit', () => {
    // Every stable @vercel/analytics still peers on @sveltejs/kit ^1 || ^2. The
    // app imports only its framework-free entry (`inject` from the package
    // root, which imports nothing), so the peer is moot; drop the override once
    // a stable release accepts kit 3.
    expect(pkg.overrides).toEqual({ '@vercel/analytics': { '@sveltejs/kit': '$@sveltejs/kit' } });
  });

  it('builds on Node 24 and installs from the lockfile on Vercel', () => {
    expect(pkg.engines).toEqual({ node: '24.x' });
    expect(vercel.installCommand).toBe('npm ci');
    // Beside it only the response headers, pinned below (the Drive auth
    // paths) and, as a whole rule set, in src/lib/security/vercel-headers.test.ts.
    expect(Object.keys(vercel).sort()).toEqual(['headers', 'installCommand']);
  });

  it("moves SvelteKit's outDir only for the e2e specs, under one variable", () => {
    // e2e/csp.spec.ts and e2e/gdrive-auth-backend.spec.ts each build or serve a
    // second app in this tree; both name the same override.
    expect(viteConfig.match(/process\.env\.[A-Z0-9_]*OUT_DIR/g) ?? []).toEqual([
      'process.env.MOKURO_E2E_KIT_OUT_DIR'
    ]);
    // Through the helper that also keeps the shared generated tsconfig on the
    // default outDir (src/lib/build/e2e-kit-out-dir.test.ts).
    expect(viteConfig).toContain('...e2eKitOutDir(process.env.MOKURO_E2E_KIT_OUT_DIR)');
  });
});

describe('Drive auth headers (vercel.json)', () => {
  const headersFor = (source: string) =>
    Object.fromEntries(
      (vercel.headers.find((h) => h.source === source)?.headers ?? []).map((h) => [h.key, h.value])
    );

  it('the OAuth callback page: never cached, never a Referer, never indexed, never framed, one script', () => {
    // Its URL carries the authorization code until its script drops it. The
    // shell's rule excludes /oauth/, so this rule carries its own nosniff and
    // framing; its CSP is enforced whatever CSP_MODE says, and allows exactly
    // what google-callback.html needs: its one same-origin script.
    expect(headersFor('/oauth/(.*)')).toEqual({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    });
  });

  it('the auth API: never cached, never a Referer, never sniffed, nothing to render or frame', () => {
    expect(headersFor('/api/(.*)')).toEqual({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
    });
  });

  it('keeps each in its own entry (a page-wide CSP is added separately)', () => {
    expect(vercel.headers.map((h) => h.source)).toEqual(
      expect.arrayContaining(['/oauth/(.*)', '/api/(.*)'])
    );
  });
});

describe('dev server', () => {
  it('listens on localhost only unless `--host` is passed', () => {
    expect(viteConfig).not.toMatch(/^\s*host\s*:/m);
  });

  it("serves the root package.json, not the project's parent directory", () => {
    expect(viteConfig).toContain("allow: ['package.json']");
    expect(viteConfig).not.toMatch(/allow:\s*\[[^\]]*'\.\.'/);
  });
});
