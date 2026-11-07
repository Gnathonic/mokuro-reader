// Types for the two SvelteKit modules this app still imports that SvelteKit 3
// deprecates. Both still exist at runtime (each re-exports its replacement and
// warns once in dev), but kit 3 ships no types for them. They are kept, rather
// than rewritten across ~100 imports, until the `$app/env` / `#lib` migration:
// https://github.com/Gnathonic/mokuro-reader/issues/359. Delete this file then.

/** Deprecated: the same four values as `$app/env`. */
declare module '$app/environment' {
  export const browser: boolean;
  export const dev: boolean;
  export const building: boolean;
  export const version: string;
}

/**
 * Deprecated: the private env module's variables as one object. Only the
 * variables declared in src/env.ts are on it; any other name reads undefined.
 */
declare module '$env/dynamic/private' {
  export const env: Record<string, string | undefined>;
}
