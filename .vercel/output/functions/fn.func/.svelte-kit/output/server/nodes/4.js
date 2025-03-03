

export const index = 4;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_page.svelte.js')).default;
export const imports = ["_app/immutable/nodes/4.a20f0ca0.js","_app/immutable/chunks/scheduler.d583122a.js","_app/immutable/chunks/index.6f9a916b.js","_app/immutable/chunks/Listgroup.551cc333.js","_app/immutable/chunks/db.1a03e27e.js","_app/immutable/chunks/singletons.32ef462a.js","_app/immutable/chunks/misc.aef7f343.js","_app/immutable/chunks/stores.09446431.js","_app/immutable/chunks/Input.cf29985b.js","_app/immutable/chunks/Loader.dfc94093.js","_app/immutable/chunks/Spinner.ecd61401.js"];
export const stylesheets = ["_app/immutable/assets/db.1d121e74.css"];
export const fonts = [];
