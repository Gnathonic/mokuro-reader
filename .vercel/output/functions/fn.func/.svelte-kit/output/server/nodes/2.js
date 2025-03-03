

export const index = 2;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_manga_/_error.svelte.js')).default;
export const imports = ["_app/immutable/nodes/2.96d993d1.js","_app/immutable/chunks/scheduler.d583122a.js","_app/immutable/chunks/index.6f9a916b.js","_app/immutable/chunks/stores.09446431.js","_app/immutable/chunks/singletons.32ef462a.js"];
export const stylesheets = [];
export const fonts = [];
