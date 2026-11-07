/**
 * `$env/dynamic/private` exposes exactly what src/env.ts declares: a variable the
 * Drive auth backend reads but nobody declared is `undefined` on every server,
 * and the backend answers 501 forever. And a secret declared `public` or
 * `static` would be shipped to the browser or inlined into the build.
 */
import { describe, expect, it } from 'vitest';
import type { EnvVarConfig } from '@sveltejs/kit/env';
import { variables } from './env';

describe('src/env.ts', () => {
  it('declares every variable the Drive auth backend reads, and no other', () => {
    // `readAuthConfig` (config.ts) and, in the test/interop modes only,
    // `googleEndpoints` (google.ts). Vitest runs in the `test` mode.
    expect(Object.keys(variables).sort()).toEqual(
      [
        'GDRIVE_CLIENT_ID',
        'GDRIVE_CLIENT_SECRET',
        'GDRIVE_POP',
        'GDRIVE_SESSION_KEY',
        'GDRIVE_SESSION_KEY_PREV',
        'GDRIVE_TEST_GOOGLE_ORIGIN',
        'VITE_GDRIVE_CLIENT_ID'
      ].sort()
    );
  });

  it('keeps every one private and read at runtime, never inlined', () => {
    for (const [name, entry] of Object.entries(variables)) {
      const config: EnvVarConfig<unknown> = entry;
      expect({ name, public: config.public, static: config.static }).toEqual({
        name,
        public: undefined,
        static: undefined
      });
    }
  });

  it('accepts every one unset: the backend then answers 501, it does not fail to start', () => {
    // SvelteKit validates each variable through its schema when the server
    // starts; any issue stops the server (`defineEnvVars` turns a function into
    // a Standard Schema).
    type Normalized = { schema: { '~standard': { validate(value: unknown): unknown } } };
    for (const entry of Object.values(variables)) {
      const { schema } = entry as Normalized;
      expect(schema['~standard'].validate(undefined)).toEqual({ value: undefined });
      expect(schema['~standard'].validate('value')).toEqual({ value: 'value' });
    }
  });
});
