/**
 * Test-only hooks that point the cloud providers at a simulator (Bunko's
 * `bunko-cloudsim`) instead of Google, Microsoft and MEGA, and hand them a
 * token instead of running Google Identity Services or MSAL.
 *
 * Every read is written `CLOUD_TEST_HOOKS ? <hook read> : fallback`, and
 * `CLOUD_TEST_HOOKS` is a compile-time constant: false in a production build,
 * so the bundler folds each guarded read to its fallback and drops the hook
 * state. `scripts/check-no-test-hooks.mjs` greps the production bundle to
 * prove it. The hooks are on under Vitest (`MODE === 'test'`) or in a build
 * made with `vite build --mode interop` (the interop rig's reader). They key on
 * the mode, never on an environment variable, so a hosting provider's settings
 * cannot switch them on in a production build.
 */

export const CLOUD_TEST_HOOKS: boolean =
  import.meta.env.MODE === 'test' || import.meta.env.MODE === 'interop';

/** Base addresses, each replacing one provider's real one. */
export type CloudBases = {
  /** Drive API, in place of `https://www.googleapis.com` (`/drive/v3/...` follows). */
  driveApi?: string;
  /** Drive uploads, in place of `https://www.googleapis.com/upload`. */
  driveUpload?: string;
  /** Microsoft Graph, in place of `https://graph.microsoft.com/v1.0`. */
  graph?: string;
  /** MEGA's API gateway (megajs `gateway`), in place of `https://g.api.mega.co.nz/`. */
  megaGateway?: string;
};

/** A Google OAuth token as Google Identity Services hands it out. */
export type GoogleTestToken = { access_token: string; expires_in: number };

type TestTokens = { google: GoogleTestToken | null; onedrive: string | null };

let bases: CloudBases | null = null;
const tokens: TestTokens = { google: null, onedrive: null };

function requireHooks(what: string): void {
  if (!CLOUD_TEST_HOOKS) {
    throw new Error(`${what}: cloud test hooks are not built into this bundle`);
  }
}

/** The overridden base for `kind`, or `fallback` (always, when hooks are off). */
export function cloudBase(kind: keyof CloudBases, fallback: string): string {
  return CLOUD_TEST_HOOKS ? (bases?.[kind] ?? fallback) : fallback;
}

/** Point the providers at a simulator (`null` puts the real addresses back). */
export function setCloudTestBases(next: CloudBases | null): void {
  requireHooks('setCloudTestBases');
  bases = next ? { ...next } : null;
}

/**
 * Hand a provider a token instead of its sign-in library's: Google Identity
 * Services for `google`, MSAL for `onedrive` (`null` takes it back).
 */
export function setCloudTestToken<P extends keyof TestTokens>(
  provider: P,
  token: TestTokens[P]
): void {
  requireHooks('setCloudTestToken');
  tokens[provider] = token;
}

/** The injected token, or null (always, when hooks are off). */
export function cloudTestToken<P extends keyof TestTokens>(provider: P): TestTokens[P] | null {
  return CLOUD_TEST_HOOKS ? tokens[provider] : null;
}

/**
 * The bases for a worker's credentials. A Web Worker loads its own copy of this
 * module, where no bases are set, so the main thread passes them along with the
 * token (as MEGA's `gateway`); `{}` unless some are set.
 */
export function cloudTestCredentials(): { cloudBases?: CloudBases } {
  return CLOUD_TEST_HOOKS && bases ? { cloudBases: { ...bases } } : {};
}

/** The `kind` base from worker credentials ({@link cloudTestCredentials}), else `fallback`. */
export function credentialBase(
  credentials: Record<string, unknown>,
  kind: keyof CloudBases,
  fallback: string
): string {
  if (!CLOUD_TEST_HOOKS) return fallback;
  const passed = (credentials.cloudBases as CloudBases | undefined)?.[kind];
  return typeof passed === 'string' ? passed : fallback;
}

/** megajs `Storage` options for the overridden gateway; `{}` unless one is set. */
export function megaGatewayOption(): { gateway?: string } {
  const gateway = CLOUD_TEST_HOOKS ? bases?.megaGateway : undefined;
  return gateway ? { gateway } : {};
}

/**
 * `globalThis.__mokuroInteropConfig` v1, set by the interop rig (Playwright
 * `addInitScript`) before any page script runs: the simulator's bases, the
 * tokens it minted, and whether the page needs the gapi REST shim (the rig
 * answers apis.google.com with an empty script).
 */
interface InteropConfig {
  v: 1;
  bases?: CloudBases;
  tokens?: { google?: GoogleTestToken; onedrive?: string };
  gapiShim?: boolean;
}

/** Apply the rig's config, once, at module init. Anything not v1 is not ours to read. */
function applyInteropConfig(raw: unknown): void {
  const config = raw as Partial<InteropConfig> | null | undefined;
  if (!config || typeof config !== 'object' || config.v !== 1) return;
  if (config.bases) setCloudTestBases(config.bases);
  const google = config.tokens?.google;
  if (google && typeof google.access_token === 'string') {
    setCloudTestToken('google', {
      access_token: google.access_token,
      expires_in: Number(google.expires_in) || 3600
    });
  }
  const onedrive = config.tokens?.onedrive;
  if (typeof onedrive === 'string') setCloudTestToken('onedrive', onedrive);
  const driveApi = config.bases?.driveApi;
  if (config.gapiShim && driveApi) {
    void import('$lib/interop/gapi-rest-shim')
      .then((m) => m.installGapiRestShim(driveApi))
      .catch((error) => console.error('[cloud-test-hooks] gapi shim failed to load:', error));
  }
}

// A hooked browser build (the interop rig drives it with Playwright) cannot
// import this module from the page, so the setters are also reachable on
// `globalThis`. Folded away with everything else in a production build.
if (CLOUD_TEST_HOOKS) {
  (globalThis as Record<string, unknown>).__mokuroCloudTestHooks = {
    setCloudTestBases,
    setCloudTestToken
  };
  applyInteropConfig((globalThis as Record<string, unknown>).__mokuroInteropConfig);
}
