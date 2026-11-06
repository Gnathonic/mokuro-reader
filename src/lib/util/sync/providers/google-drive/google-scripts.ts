/**
 * The two Google scripts Drive needs — gapi (`api.js`: the Drive client and the
 * Picker) and Google Identity Services (`gsi/client`: the OAuth token client) —
 * loaded on demand instead of by a `<script>` in `app.html`.
 *
 * In `app.html` they ran on every visit with full access to the origin, and
 * every visitor made requests to Google, whether or not they ever used Drive.
 * Now they load only when Drive can actually be used next:
 *
 *   - at boot, when Drive is the active provider (`initializeProviders`), and
 *   - when the cloud page opens (`CloudView`), so the Connect button finds
 *     them already there.
 *
 * NEVER first from the Connect click handler. The GIS popup must open inside
 * the click's user activation; a click that first waits for two script
 * downloads has used it up, and Safari (and popup blockers generally) then
 * refuse the popup. `driveApiClient.initialize()` still waits for gapi
 * (`loadGapiScript`) and `tokenManager.initTokenClient()` for GIS
 * (`loadGisScript`) — by then each only joins the load already in flight or done.
 *
 * Each waiter waits for ITS script alone. With the Drive auth backend
 * (`auth-backend.ts`) GIS is only the popup fallback: Drive's client must still
 * come up when GIS is blocked or fails, as it did when both were tags in
 * `app.html` — a combined wait would fail the Drive client on GIS's error.
 *
 * The Content-Security-Policy cannot vary per visit, so it allows these exact
 * paths either way (`src/lib/security/csp-policy.js`). No Subresource Integrity:
 * Google serves both unversioned and changes them in place.
 */

export const GAPI_SCRIPT_URL = 'https://apis.google.com/js/api.js';
export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
export const GOOGLE_SCRIPT_URLS = [GAPI_SCRIPT_URL, GIS_SCRIPT_URL] as const;

const loads = new Map<string, Promise<void>>();

/** One script's load: one `<script>` for the page's lifetime, unless it failed. */
function loadScript(src: string): Promise<void> {
  const pending = loads.get(src);
  if (pending) return pending;

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener(
      'error',
      () => {
        // Forget the failure, and the element: offline now is not offline
        // forever, and the next caller (a retry, the next cloud page visit)
        // gets a fresh attempt.
        loads.delete(src);
        script.remove();
        reject(new Error(`Failed to load ${src}`));
      },
      { once: true }
    );
    document.head.appendChild(script);
  });
  loads.set(src, promise);
  return promise;
}

/**
 * Inject both scripts (once per page) and settle when both have run. Rejects
 * when either fails to load; a later call tries that one again.
 */
export function loadGoogleScripts(): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  return Promise.all(GOOGLE_SCRIPT_URLS.map(loadScript)).then(() => undefined);
}

/** gapi alone (the Drive client and the Picker): settles with ITS load, whatever GIS does. */
export function loadGapiScript(): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  return loadScript(GAPI_SCRIPT_URL);
}

/** GIS alone (the OAuth token client; with the auth backend, only the popup fallback). */
export function loadGisScript(): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  return loadScript(GIS_SCRIPT_URL);
}

/**
 * Start loading the scripts and do not wait: for the moments BEFORE a Drive
 * action, so the action itself finds them ready. A failure here is only logged;
 * the action that needs the scripts reports it (each loader retries a failure).
 */
export function preloadGoogleScripts(): void {
  loadGoogleScripts().catch((error) => {
    console.debug('Google scripts did not load yet:', error);
  });
}

/** Tests only: forget every load, as a fresh page would. */
export function resetGoogleScriptsForTests(): void {
  loads.clear();
}
