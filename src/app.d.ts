// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
  /** The `test` or `interop` mode: the cloud test hooks are on (a `define`, vite.config.ts). */
  const __MOKURO_TEST_HOOKS__: boolean;
  /** The `interop` mode: a hermetic build for the interop rig (a `define`, vite.config.ts). */
  const __MOKURO_INTEROP__: boolean;

  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface Platform {}
  }
}

export {};
