

export const index = 3;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_manga_/_volume_/_layout.svelte.js')).default;
export const imports = ["_app/immutable/nodes/3.b5748f1d.js","_app/immutable/chunks/scheduler.d583122a.js","_app/immutable/chunks/index.6f9a916b.js"];
export const stylesheets = ["_app/immutable/assets/3.120bc3e7.css"];
export const fonts = [];
