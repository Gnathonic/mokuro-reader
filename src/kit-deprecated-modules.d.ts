// Types for the SvelteKit module this app still imports that SvelteKit 3
// deprecates. It still exists at runtime (it re-exports its replacement and
// warns once in dev), but kit 3 ships no types for it. It is kept, rather
// than rewritten across ~100 imports, until the `$app/env` / `#lib` migration:
// https://github.com/Gnathonic/mokuro-reader/issues/359. Delete this file then.

/** Deprecated: the same four values as `$app/env`. */
declare module '$app/environment' {
  export const browser: boolean;
  export const dev: boolean;
  export const building: boolean;
  export const version: string;
}
