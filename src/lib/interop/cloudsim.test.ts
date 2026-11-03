import { afterEach, describe, expect, it } from 'vitest';
import { cloudsimForSuite } from './cloudsim';

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env;
const saved = { url: env.CLOUDSIM_URL, require: env.REQUIRE_CLOUDSIM };

describe('cloudsimForSuite', () => {
  afterEach(() => {
    env.CLOUDSIM_URL = saved.url;
    env.REQUIRE_CLOUDSIM = saved.require;
    if (saved.url === undefined) delete env.CLOUDSIM_URL;
    if (saved.require === undefined) delete env.REQUIRE_CLOUDSIM;
  });

  it('skips (null) without a simulator when none is required', () => {
    delete env.CLOUDSIM_URL;
    delete env.REQUIRE_CLOUDSIM;
    expect(cloudsimForSuite()).toBeNull();
  });

  it('throws when one is required (CI) and none is set, so no run passes on skips', () => {
    delete env.CLOUDSIM_URL;
    env.REQUIRE_CLOUDSIM = '1';
    expect(() => cloudsimForSuite()).toThrow(/REQUIRE_CLOUDSIM=1/);
  });

  it('returns the simulator without a trailing slash', () => {
    env.CLOUDSIM_URL = 'http://127.0.0.1:4000/';
    env.REQUIRE_CLOUDSIM = '1';
    expect(cloudsimForSuite()).toBe('http://127.0.0.1:4000');
  });
});
