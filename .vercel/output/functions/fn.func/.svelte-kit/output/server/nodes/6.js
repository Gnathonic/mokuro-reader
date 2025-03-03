

export const index = 6;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_manga_/_volume_/_page.svelte.js')).default;
export const imports = ["_app/immutable/nodes/6.bb4d8aa0.js","_app/immutable/chunks/scheduler.d583122a.js","_app/immutable/chunks/index.6f9a916b.js","_app/immutable/chunks/stores.09446431.js","_app/immutable/chunks/singletons.32ef462a.js","_app/immutable/chunks/misc.aef7f343.js","_app/immutable/chunks/db.1a03e27e.js","_app/immutable/chunks/Settings.a051f286.js","_app/immutable/chunks/Listgroup.551cc333.js","_app/immutable/chunks/snackbar.76b9f199.js","_app/immutable/chunks/index.9c9c4205.js","_app/immutable/chunks/Input.cf29985b.js","_app/immutable/chunks/TrashBinSolid.79f7b2ca.js","_app/immutable/chunks/navigation.873987b5.js","_app/immutable/chunks/Spinner.ecd61401.js"];
export const stylesheets = ["_app/immutable/assets/6.436824e7.css","_app/immutable/assets/db.1d121e74.css"];
export const fonts = [];
