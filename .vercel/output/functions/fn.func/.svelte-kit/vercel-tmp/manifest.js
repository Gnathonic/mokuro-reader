export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["favicon.png","icons/icon-128x128.png","icons/icon-144x144.png","icons/icon-152x152.png","icons/icon-192x192.png","icons/icon-384x384.png","icons/icon-48x48.png","icons/icon-512x512.png","icons/icon-72x72.png","icons/icon-96x96.png","manifest.json","service-worker.js"]),
	mimeTypes: {".png":"image/png",".json":"application/json"},
	_: {
		client: {"start":"_app/immutable/entry/start.82bcd031.js","app":"_app/immutable/entry/app.174c7508.js","imports":["_app/immutable/entry/start.82bcd031.js","_app/immutable/chunks/scheduler.d583122a.js","_app/immutable/chunks/singletons.32ef462a.js","_app/immutable/entry/app.174c7508.js","_app/immutable/chunks/preload-helper.a4192956.js","_app/immutable/chunks/scheduler.d583122a.js","_app/immutable/chunks/index.6f9a916b.js"],"stylesheets":[],"fonts":[]},
		nodes: [
			__memo(() => import('../output/server/nodes/0.js')),
			__memo(() => import('../output/server/nodes/1.js')),
			__memo(() => import('../output/server/nodes/2.js')),
			__memo(() => import('../output/server/nodes/3.js')),
			__memo(() => import('../output/server/nodes/4.js')),
			__memo(() => import('../output/server/nodes/5.js')),
			__memo(() => import('../output/server/nodes/6.js')),
			__memo(() => import('../output/server/nodes/7.js')),
			__memo(() => import('../output/server/nodes/8.js'))
		],
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 4 },
				endpoint: null
			},
			{
				id: "/cloud",
				pattern: /^\/cloud\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 7 },
				endpoint: null
			},
			{
				id: "/upload",
				pattern: /^\/upload\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 8 },
				endpoint: null
			},
			{
				id: "/[manga]",
				pattern: /^\/([^/]+?)\/?$/,
				params: [{"name":"manga","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,,], errors: [1,2,], leaf: 5 },
				endpoint: null
			},
			{
				id: "/[manga]/[volume]",
				pattern: /^\/([^/]+?)\/([^/]+?)\/?$/,
				params: [{"name":"manga","optional":false,"rest":false,"chained":false},{"name":"volume","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,,3,], errors: [1,2,,], leaf: 6 },
				endpoint: null
			}
		],
		matchers: async () => {
			
			return {  };
		}
	}
}
})();
