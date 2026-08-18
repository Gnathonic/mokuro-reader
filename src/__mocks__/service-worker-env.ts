// Test stand-in for SvelteKit's `$service-worker` virtual module.
// Wired up via `test.alias` in vite.config.ts.
export const build = ['/_app/immutable/entry/app.js'];
export const files = ['/favicon.png'];
export const version = 'test-version';
export const base = '';
export const prerendered: string[] = [];
