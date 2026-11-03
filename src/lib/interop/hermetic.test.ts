/**
 * An interop build reaches no host off the machine but the two Google scripts
 * the rig answers empty: the rig refuses every other request and fails the
 * spec that made it (mokuro-bunko `interop/e2e/rig/egress.mjs`). Those two are
 * no longer in app.html — they are injected on demand (`google-scripts.ts`) —
 * so the hermetic shell names no off-machine address at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import APP_HTML from '../../app.html?raw';
import { hermeticShell } from './hermetic';
import { GOOGLE_SCRIPT_URLS } from '$lib/util/sync/providers/google-drive/google-scripts';

/** What the rig answers (empty): the scripts `google-scripts.ts` injects. */
const STUBBED_BY_THE_RIG: readonly string[] = GOOGLE_SCRIPT_URLS;

/** Every absolute http(s) address in `html`. */
function addresses(html: string): string[] {
  return [...html.matchAll(/https?:\/\/[^\s'"<>)]+/g)].map((m) => m[0]);
}

describe('hermeticShell', () => {
  it('leaves app.html no address off the machine', () => {
    // app.html does name some (else this test proves nothing): the font
    // host's preconnects and the jidoujisho icon on the public host.
    expect(addresses(APP_HTML)).not.toEqual([]);
    expect(addresses(hermeticShell(APP_HTML))).toEqual([]);
  });

  it('has no Google script in the shell: they load on demand, and only those two', () => {
    expect(APP_HTML).not.toMatch(/<script\b[^>]*\bsrc=/);
    expect(STUBBED_BY_THE_RIG).toEqual([
      'https://apis.google.com/js/api.js',
      'https://accounts.google.com/gsi/client'
    ]);
  });

  it('keeps the elements, only without the address', () => {
    const shell = hermeticShell(APP_HTML);
    expect(shell).toContain('id="popupAbout"');
    expect(shell).toContain('%sveltekit.body%');
    expect(shell).not.toContain('rel="preconnect"');
    expect(shell).toMatch(/background-image: none;/);
  });
});

describe('the server hook', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** What `handle` answers for a page, with `resolve` recording its options. */
  async function render(): Promise<string> {
    const { handle } = await import('../../hooks.server');
    const resolve = vi.fn(async (_event: unknown, opts?: { transformPageChunk?: unknown }) => {
      const transform = opts?.transformPageChunk as
        | ((input: { html: string; done: boolean }) => string)
        | undefined;
      return new Response(transform ? transform({ html: APP_HTML, done: true }) : APP_HTML);
    });
    const response = await handle({ event: {} as never, resolve: resolve as never });
    return response.text();
  }

  it('serves the shell as it is outside an interop build', async () => {
    expect(await render()).toBe(APP_HTML);
  });

  it('serves the hermetic shell from an interop build', async () => {
    vi.stubEnv('MODE', 'interop');
    expect(await render()).toBe(hermeticShell(APP_HTML));
  });
});
