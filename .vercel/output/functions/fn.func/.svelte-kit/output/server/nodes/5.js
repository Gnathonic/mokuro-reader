

export const index = 5;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_manga_/_page.svelte.js')).default;
export const imports = ["_app/immutable/nodes/5.15a54e3c.js","_app/immutable/chunks/scheduler.d583122a.js","_app/immutable/chunks/index.6f9a916b.js","_app/immutable/chunks/Listgroup.551cc333.js","_app/immutable/chunks/db.1a03e27e.js","_app/immutable/chunks/singletons.32ef462a.js","_app/immutable/chunks/misc.aef7f343.js","_app/immutable/chunks/stores.09446431.js","_app/immutable/chunks/navigation.873987b5.js","_app/immutable/chunks/index.9c9c4205.js","_app/immutable/chunks/TrashBinSolid.79f7b2ca.js","_app/immutable/chunks/zip-entry.fa66699e.js"];
export const stylesheets = ["_app/immutable/assets/db.1d121e74.css"];
export const fonts = [];
