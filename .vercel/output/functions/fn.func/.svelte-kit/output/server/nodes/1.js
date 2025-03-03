

export const index = 1;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/fallbacks/error.svelte.js')).default;
export const imports = ["_app/immutable/nodes/1.654d4bdf.js","_app/immutable/chunks/scheduler.d583122a.js","_app/immutable/chunks/index.6f9a916b.js","_app/immutable/chunks/stores.09446431.js","_app/immutable/chunks/singletons.32ef462a.js"];
export const stylesheets = [];
export const fonts = [];
