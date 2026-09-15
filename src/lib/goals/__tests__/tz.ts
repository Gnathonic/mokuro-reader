import { afterAll, beforeAll, expect } from 'vitest';

// `process` without @types/node. Only `env.TZ` is touched.
declare const process: { env: Record<string, string | undefined> };

/**
 * Run the surrounding describe in a fixed time zone, and PROVE it took effect.
 *
 * Setting `process.env.TZ` only re-dates `Date` under vitest's default `forks`
 * pool; under `threads` it is silently a no-op. Without the self-check, the DST
 * regression tests would keep passing in a zone that has no DST at all — green,
 * and pinning nothing. The assertion turns that into a loud failure.
 */
export function pinTimeZone(timeZone: string) {
  let original: string | undefined;

  beforeAll(() => {
    original = process.env.TZ;
    process.env.TZ = timeZone;

    expect(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      `TZ pin did not take effect — these tests assert DST behaviour and are ` +
        `meaningless outside ${timeZone}. Vitest's pool is probably not "forks".`
    ).toBe(timeZone);
  });

  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });
}
