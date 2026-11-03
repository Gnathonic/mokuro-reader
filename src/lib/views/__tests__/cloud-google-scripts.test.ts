import { describe, expect, it } from 'vitest';

/**
 * The cloud screen starts the Google scripts loading when it MOUNTS, and the
 * Drive Connect path never starts them itself: GIS's popup has to open inside
 * the click's user activation, which two script downloads in the handler would
 * spend (Safari then blocks the popup). Asserted against the source, like
 * `cloud-devices.test.ts`: rendering CloudView stands up five providers. The
 * real-browser half is `e2e/csp.spec.ts` (the scripts arrive on the cloud page).
 */
const sources = import.meta.glob('../CloudView.svelte', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;
const source = Object.values(sources)[0] ?? '';

/** The body of `function name(...) { ... }` in the component's script. */
function functionBody(name: string): string {
  const start = source.search(new RegExp(`(async )?function ${name}\\(`));
  expect(start, `function ${name}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

describe('the Google scripts and the cloud screen', () => {
  it('are preloaded first thing when the screen mounts', () => {
    const mount = source.indexOf('onMount(async () => {');
    expect(mount).toBeGreaterThan(-1);
    const firstStatement = source.slice(mount, source.indexOf(';', mount) + 1);
    expect(firstStatement).toContain('preloadGoogleScripts()');
  });

  it('are never loaded from the Drive Connect handler', () => {
    const connect = functionBody('handleGoogleDriveLogin');
    expect(connect).not.toMatch(/loadGoogleScripts|preloadGoogleScripts|createElement\('script'\)/);
  });
});
