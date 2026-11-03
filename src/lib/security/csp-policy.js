// The Content-Security-Policy of the HTML shell, as SvelteKit's `kit.csp`.
//
// Plain JavaScript (JSDoc-typed) because `svelte.config.js` imports it: Node
// loads that file directly, before Vite or any TypeScript tooling runs.
//
// The phase is chosen at BUILD time by the `CSP_MODE` environment variable:
//
//   off          (default) no policy at all: the shell goes out as it always did
//   report-only  `Content-Security-Policy-Report-Only`: nothing is blocked; every
//                violation still fires `securitypolicyviolation`, which the page's
//                ring buffer keeps (`csp-violations.ts`)
//   enforce      `Content-Security-Policy`
//
// Rollout: report-only on beta, then enforce on beta, then report-only on
// production, then enforce on production. See the commit that added this file.
//
// Why each source is here — every one was found in the code or the build output,
// nothing is broad by default:
//
// script-src
//   'self'               the app's chunks, and Vercel Analytics' same-origin script
//   'wasm-unsafe-eval'   zip.js (deflate) and pica (resize) compile WebAssembly
//   apis.google.com/js/api.js, /_/scs/   gapi's loader, and the modules it pulls
//                        in itself (`client`, `picker`) from the /_/scs/ prefix
//   accounts.google.com/gsi/client       Google Identity Services
//   NEVER bare accounts.google.com or www.gstatic.com: both hosts serve JSONP
//   endpoints and AngularJS builds, the known gadgets that turn an allowed host
//   into a CSP bypass. Exact paths keep them out.
//   SvelteKit adds the sha256 of its own inline boot script (`mode: 'hash'`). Hash,
//   never nonce: the shell is cached by the CDN, and a cached nonce is no nonce.
// style-src
//   'self'               the built stylesheets (night mode's rules included — they
//                        live in `src/lib/styles/night-mode.css`, not in an inline
//                        <style>, which no hash in this policy would cover)
//   fonts.googleapis.com the Noto Sans JP stylesheet fallback (`web-fonts.ts`)
//   accounts.google.com/gsi/style        the stylesheet GIS adds for itself
// style-src-attr 'unsafe-inline'
//   Svelte `style:` bindings, Flowbite and floating-ui position everything with
//   inline style attributes. An attribute cannot run script.
// img-src 'self' blob: data: https:
//   covers and pages are object URLs; AniList, catalogs and cloud covers are https
// font-src 'self' https://fonts.gstatic.com data:
// connect-src 'self' https: http: data: blob:
//   WebDAV and catalog servers are user-chosen, any host. `http:` is for loopback
//   and LAN (AnkiConnect on 127.0.0.1, a WebDAV server at home). `data:` is
//   zip.js fetching its inlined WebAssembly; `blob:` reads object URLs back.
// frame-src
//   'self'
//   accounts.google.com  GIS
//   docs.google.com, drive.google.com     the Google Picker dialog
//   content.googleapis.com                gapi.client's request proxy frame
//   login.microsoftonline.com             MSAL's silent token renewal frame
//   login.live.com       the personal-account hop of that same frame: with the
//                        `/common` authority, a personal Microsoft account (the
//                        usual OneDrive one) is redirected through it and back.
//                        frame-src is checked on every redirect of a child
//                        frame, so without it the renewal — which MSAL falls
//                        back to once the 24 h SPA refresh token has expired —
//                        times out (monitor_window_timeout, not an
//                        interaction-required error: no reconnect prompt).
// worker-src 'self' blob: data:
//   the app's module workers and the service worker; pica starts its resize
//   workers from blob: URLs and probes OffscreenCanvas support with a data:
//   worker, and zip.js starts its codec workers from a data: URL (seen in the
//   e2e run: without data: the probe is a violation on every thumbnail, and an
//   archive import inside the file worker hangs)
// object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'
// No default-src: every fetch directive that can run code is named above, and a
// default would only add media-src/manifest-src restrictions the app has no
// use for — while refusing the https: audio and video that extensions (Migaku's
// sentence audio, say) inject into the page.
//
// Browsers. 'wasm-unsafe-eval' needs Safari 16 and style-src-attr Safari 15.4.
// Older Safari (iOS/iPadOS 15 devices that cannot update) ignores what it does
// not know: under enforce it would refuse WebAssembly — in the worker policy
// too, which vercel.json enforces whatever CSP_MODE says — and every inline
// style attribute. Safari below 16 is knowingly unsupported under enforce;
// check one such device by hand, if one is still to be supported.
//
// Not allowed: the Vercel Toolbar. Vercel injects it (scripts, frames and a
// websocket from its own hosts) into PREVIEW deployments only — beta among them —
// and this policy refuses it, so its violations show up there. Turn the toolbar
// off for the project's preview deployments (Vercel project settings) rather
// than widening this policy, so that beta enforces exactly what production does.
//
// Deliberately absent: upgrade-insecure-requests (it would rewrite the http:
// loopback/LAN requests above to https and break them), Trusted Types, COEP and
// CORP (each breaks a cross-origin integration the app relies on).
//
// Report-only needs `report-to`: SvelteKit throws while rendering EVERY page
// (a 500 everywhere) when a report-only policy has neither report-to nor
// report-uri. `report-to csp-noop` names a reporting group no Reporting-Endpoints
// header defines, so browsers send nothing anywhere. Never a same-origin
// report-uri instead: every report would be a serverless function invocation.

/** @typedef {'off' | 'report-only' | 'enforce'} CspMode */
/** @typedef {NonNullable<NonNullable<import('@sveltejs/kit').KitConfig['csp']>['directives']>} CspDirectives */
/** @typedef {NonNullable<import('@sveltejs/kit').KitConfig['csp']>} KitCsp */

/** @type {readonly CspMode[]} */
export const CSP_MODES = ['off', 'report-only', 'enforce'];

/** The reporting group a report-only policy names, defined nowhere on purpose. */
export const CSP_NOOP_REPORT_GROUP = 'csp-noop';

/**
 * The `CSP_MODE` value, checked. Unset or empty is `off`; anything that is not a
 * known mode fails the build — a typo must never ship a page with no policy (or
 * an enforced one) by accident.
 *
 * @param {string | undefined} value
 * @returns {CspMode}
 */
export function parseCspMode(value) {
  const mode = (value ?? '').trim().toLowerCase();
  if (mode === '') return 'off';
  const known = CSP_MODES.find((m) => m === mode);
  if (!known) {
    throw new Error(`CSP_MODE must be one of ${CSP_MODES.join(', ')} (got "${value}")`);
  }
  return known;
}

/**
 * The shell's directives. A fresh object each call: SvelteKit adds its script
 * hashes to the arrays it is handed.
 *
 * @returns {CspDirectives}
 */
export function cspDirectives() {
  return {
    'script-src': [
      'self',
      'wasm-unsafe-eval',
      'https://apis.google.com/js/api.js',
      'https://apis.google.com/_/scs/',
      'https://accounts.google.com/gsi/client'
    ],
    'style-src': ['self', 'https://fonts.googleapis.com', 'https://accounts.google.com/gsi/style'],
    'style-src-attr': ['unsafe-inline'],
    'img-src': ['self', 'blob:', 'data:', 'https:'],
    'font-src': ['self', 'https://fonts.gstatic.com', 'data:'],
    'connect-src': ['self', 'https:', 'http:', 'data:', 'blob:'],
    'frame-src': [
      'self',
      'https://accounts.google.com',
      'https://docs.google.com',
      'https://drive.google.com',
      'https://content.googleapis.com',
      'https://login.microsoftonline.com',
      'https://login.live.com'
    ],
    'worker-src': ['self', 'blob:', 'data:'],
    'object-src': ['none'],
    'base-uri': ['self'],
    'form-action': ['self'],
    'frame-ancestors': ['self']
  };
}

/**
 * `kit.csp` for a mode. Always `mode: 'hash'`: the default, `'auto'`, would
 * use nonces on the server-rendered shell.
 *
 * @param {CspMode} mode
 * @returns {KitCsp}
 */
export function kitCsp(mode) {
  switch (mode) {
    case 'off':
      return { mode: 'hash' };
    case 'enforce':
      return { mode: 'hash', directives: cspDirectives() };
    case 'report-only':
      return {
        mode: 'hash',
        reportOnly: { ...cspDirectives(), 'report-to': [CSP_NOOP_REPORT_GROUP] }
      };
  }
}
