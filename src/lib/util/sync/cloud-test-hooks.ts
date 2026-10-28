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

let bases: CloudBases | null = null;
const tokens: { onedrive: string | null } = { onedrive: null };

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

/** Hand the OneDrive provider a token instead of MSAL's (`null` takes it back). */
export function setCloudTestToken(provider: 'onedrive', token: string | null): void {
  requireHooks('setCloudTestToken');
  tokens[provider] = token;
}

/** The injected token, or null (always, when hooks are off). */
export function cloudTestToken(provider: 'onedrive'): string | null {
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

// A hooked browser build (the interop rig drives it with Playwright) cannot
// import this module from the page, so the setters are also reachable on
// `globalThis`. Folded away with everything else in a production build.
if (CLOUD_TEST_HOOKS) {
  (globalThis as Record<string, unknown>).__mokuroCloudTestHooks = {
    setCloudTestBases,
    setCloudTestToken
  };
}
