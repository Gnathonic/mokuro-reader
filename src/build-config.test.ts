/**
 * The build and dev-server settings that keep a deploy reproducible and the
 * dev server off the LAN. Each is a one-line config change that a later edit
 * can silently undo, so they are pinned here.
 */
import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import vercel from '../vercel.json';
import lockText from '../package-lock.json?raw';
import svelteConfig from '../svelte.config.js?raw';
// As text: importing vite.config.ts loads esbuild, which refuses jsdom.
import viteConfig from '../vite.config.ts?raw';

const lock = JSON.parse(lockText);
const devDependencies: Record<string, string | undefined> = pkg.devDependencies;

describe('production build', () => {
  it('fails when a cloud test hook reaches the bundle', () => {
    expect(pkg.scripts.build).toBe('vite build && node scripts/check-no-test-hooks.mjs');
  });

  it('uses the lockfile-pinned Vercel adapter, never adapter-auto', () => {
    // adapter-auto installs adapter-vercel at build time, outside the lockfile.
    expect(devDependencies['@sveltejs/adapter-auto']).toBeUndefined();
    expect(devDependencies['@sveltejs/adapter-vercel']).toMatch(/^\^6\./);
    expect(lock.packages['node_modules/@sveltejs/adapter-vercel']?.version).toMatch(/^6\./);
    expect(lock.packages['node_modules/@sveltejs/adapter-auto']).toBeUndefined();

    expect(svelteConfig).toContain("from '@sveltejs/adapter-vercel'");
    // Without an explicit runtime the adapter derives one from the build
    // machine's Node and throws on any major Vercel does not run.
    expect(svelteConfig).toMatch(/adapter\(\{\s*runtime:\s*'nodejs24\.x'\s*\}\)/);
  });

  it('builds on Node 24 and installs from the lockfile on Vercel', () => {
    expect(pkg.engines).toEqual({ node: '24.x' });
    expect(vercel).toEqual({ installCommand: 'npm ci' });
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
