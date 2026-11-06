/**
 * The Google scripts are injected on demand, once per page, and a failed load
 * is retried by the next caller (`google-scripts.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GAPI_SCRIPT_URL,
  GIS_SCRIPT_URL,
  loadGapiScript,
  loadGisScript,
  loadGoogleScripts,
  preloadGoogleScripts,
  resetGoogleScriptsForTests
} from './google-scripts';

const scripts = (src: string) =>
  [...document.head.querySelectorAll('script')].filter((s) => s.src === src);

/** Fire `load` (or `error`) on the one injected script for `src`. */
function settle(src: string, outcome: 'load' | 'error') {
  const [script] = scripts(src);
  expect(script, `a <script> for ${src}`).toBeTruthy();
  script.dispatchEvent(new Event(outcome));
}

afterEach(() => {
  document.head.querySelectorAll('script').forEach((s) => s.remove());
  resetGoogleScriptsForTests();
  vi.restoreAllMocks();
});

describe('loadGoogleScripts', () => {
  it('injects gapi and GIS (async), and settles once both have loaded', async () => {
    let settled = false;
    const load = loadGoogleScripts().then(() => (settled = true));

    expect(scripts(GAPI_SCRIPT_URL)).toHaveLength(1);
    expect(scripts(GIS_SCRIPT_URL)).toHaveLength(1);
    expect(scripts(GAPI_SCRIPT_URL)[0].async).toBe(true);

    settle(GAPI_SCRIPT_URL, 'load');
    await Promise.resolve();
    expect(settled).toBe(false);

    settle(GIS_SCRIPT_URL, 'load');
    await load;
    expect(settled).toBe(true);
  });

  it('injects each script once, however many callers ask', async () => {
    const first = loadGoogleScripts();
    const second = loadGoogleScripts();
    settle(GAPI_SCRIPT_URL, 'load');
    settle(GIS_SCRIPT_URL, 'load');
    await Promise.all([first, second]);
    await loadGoogleScripts();

    expect(scripts(GAPI_SCRIPT_URL)).toHaveLength(1);
    expect(scripts(GIS_SCRIPT_URL)).toHaveLength(1);
  });

  it('rejects when one fails, drops its element, and the next call tries again', async () => {
    const failed = loadGoogleScripts();
    settle(GAPI_SCRIPT_URL, 'load');
    settle(GIS_SCRIPT_URL, 'error');
    await expect(failed).rejects.toThrow(GIS_SCRIPT_URL);
    expect(scripts(GIS_SCRIPT_URL)).toHaveLength(0);

    const retry = loadGoogleScripts();
    // gapi had loaded: not fetched again. GIS gets a fresh element.
    expect(scripts(GAPI_SCRIPT_URL)).toHaveLength(1);
    expect(scripts(GIS_SCRIPT_URL)).toHaveLength(1);
    settle(GIS_SCRIPT_URL, 'load');
    await expect(retry).resolves.toBeUndefined();
  });
});

describe('loadGapiScript / loadGisScript', () => {
  it('each waits for its own script alone: GIS failing never fails gapi', async () => {
    // Both in flight, as after a preload; then GIS is blocked and gapi loads.
    preloadGoogleScripts();
    const gapi = loadGapiScript();
    const gis = loadGisScript();
    settle(GIS_SCRIPT_URL, 'error');
    await expect(gis).rejects.toThrow(GIS_SCRIPT_URL);
    settle(GAPI_SCRIPT_URL, 'load');
    await expect(gapi).resolves.toBeUndefined();
  });

  it('joins a load already in flight instead of injecting a second tag', async () => {
    const both = loadGoogleScripts();
    const gapi = loadGapiScript();
    expect(scripts(GAPI_SCRIPT_URL)).toHaveLength(1);
    settle(GAPI_SCRIPT_URL, 'load');
    await expect(gapi).resolves.toBeUndefined();
    settle(GIS_SCRIPT_URL, 'load');
    await both;
    expect(scripts(GIS_SCRIPT_URL)).toHaveLength(1);
  });

  it('loads only the one asked for', () => {
    void loadGisScript();
    expect(scripts(GIS_SCRIPT_URL)).toHaveLength(1);
    expect(scripts(GAPI_SCRIPT_URL)).toHaveLength(0);
  });
});

describe('preloadGoogleScripts', () => {
  it('starts the load without waiting, and swallows a failure', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    preloadGoogleScripts();
    expect(scripts(GAPI_SCRIPT_URL)).toHaveLength(1);
    expect(scripts(GIS_SCRIPT_URL)).toHaveLength(1);

    settle(GAPI_SCRIPT_URL, 'error');
    await vi.waitFor(() => expect(debug).toHaveBeenCalled());
  });
});
