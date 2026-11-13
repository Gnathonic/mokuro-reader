/**
 * The server's environment variables (SvelteKit 3: `$app/env/private` exposes
 * exactly the variables declared here, and nothing else from `process.env`).
 *
 * Every one is the Drive auth backend's (`src/lib/server/gdrive-auth`), every
 * one is private (never `public`: the routes alone may import them) and dynamic
 * (never `static`: read when the server starts, so a build never contains a
 * secret — `scripts/check-no-server-secrets.mjs` proves it). Every one may be
 * unset: the backend then answers 501 `not_configured` and the client keeps
 * the implicit sign-in (`readAuthConfig`).
 */
import { defineEnvVars } from '@sveltejs/kit/env';

/** Unset (or empty) is a valid value: `readAuthConfig` decides what is usable. */
const optional = (value: string | undefined): string | undefined => value;

/**
 * Same constant as `google.ts`'s: the test-only Google stand-in exists only in
 * the `test` and `interop` modes. A production build folds the branch away
 * together with the variable's name (`scripts/check-no-test-hooks.mjs`), so no
 * hosting setting can point a deployed server at another token endpoint.
 */
const GOOGLE_TEST_HOOKS: boolean =
  import.meta.env.MODE === 'test' || import.meta.env.MODE === 'interop';

export const variables = defineEnvVars({
  GDRIVE_CLIENT_ID: {
    schema: optional,
    description: 'The Google OAuth client id (falls back to VITE_GDRIVE_CLIENT_ID).'
  },
  VITE_GDRIVE_CLIENT_ID: {
    schema: optional,
    description: "The client's Google OAuth client id, read by the server as a fallback."
  },
  GDRIVE_CLIENT_SECRET: { schema: optional, description: 'The Google OAuth client secret.' },
  GDRIVE_SESSION_KEY: {
    schema: optional,
    description: 'Base64, 32 bytes: seals every new refresh cookie.'
  },
  GDRIVE_SESSION_KEY_PREV: {
    schema: optional,
    description: 'Base64, 32 bytes: the key before a rotation, still opens older cookies.'
  },
  GDRIVE_POP: {
    schema: optional,
    description: '`off` lifts the proof-of-possession requirement on bound cookies.'
  },
  ...(GOOGLE_TEST_HOOKS ? { GDRIVE_TEST_GOOGLE_ORIGIN: { schema: optional } } : {})
});
