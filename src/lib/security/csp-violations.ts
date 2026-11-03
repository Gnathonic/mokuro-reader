/**
 * The page's own record of Content-Security-Policy violations: the last
 * {@link CSP_VIOLATION_CAPACITY} `securitypolicyviolation` events, kept in
 * memory and sent nowhere.
 *
 * A report-only policy blocks nothing, so the only way to learn what an
 * enforced one WOULD break — on a real device, with real extensions and real
 * providers — is to look. Open the console on the page and run
 * `__mokuroCspViolations()`; it returns a copy of the buffer, oldest first.
 * The policy names a reporting group nothing defines (`csp-policy.js`), so
 * this buffer is the whole collection mechanism: no request ever carries a
 * report off the device.
 *
 * Workers. A violation raised inside a worker fires on THAT worker's global,
 * not on the document, and Playwright sees no console message for it. The
 * app's own workers therefore call {@link forwardWorkerCspViolations} first
 * thing, which passes each one to the document's buffer over a
 * BroadcastChannel (its own channel, so no worker's message protocol sees
 * it); those entries carry `context: 'worker <path>'`. A BroadcastChannel
 * reaches every tab of the origin, so a buffer can hold another tab's worker
 * violations too. Workers the app does not write — zip.js's codec workers,
 * pica's resize workers, both started from blob:/data: URLs — are not
 * covered: their violations show only as the feature failing.
 */

export const CSP_VIOLATION_CAPACITY = 100;

/** The global the buffer is read through (devtools, the e2e spec). */
export const CSP_VIOLATIONS_GLOBAL = '__mokuroCspViolations';

/** The BroadcastChannel the app's workers forward their violations on. */
export const CSP_VIOLATION_CHANNEL = 'mokuro-csp-violations';

/** Where a violation fired: the document's own context. */
export const DOCUMENT_CONTEXT = 'document';

export interface CspViolation {
  /** `Date.now()` when the event fired. */
  at: number;
  /** `enforce` (blocked) or `report` (report-only: allowed, but counted). */
  disposition: string;
  /** The directive that matched, e.g. `script-src-elem`. */
  directive: string;
  /** What was refused: a URL, or `inline` / `eval` / `wasm-eval` / `data` / `blob`. */
  blockedURI: string;
  /** The script that caused it, when the browser knows. */
  sourceFile: string;
  line: number;
  column: number;
  /** The first 40 characters of an inline script or style, when reported. */
  sample: string;
  /** `document`, or `worker <path>` for one forwarded by an app worker. */
  context: string;
}

/** The fields of a `SecurityPolicyViolationEvent` the buffer keeps. */
export type ViolationEventLike = Pick<
  SecurityPolicyViolationEvent,
  | 'disposition'
  | 'effectiveDirective'
  | 'violatedDirective'
  | 'blockedURI'
  | 'sourceFile'
  | 'lineNumber'
  | 'columnNumber'
  | 'sample'
>;

export function toViolation(
  event: ViolationEventLike,
  at = Date.now(),
  context = DOCUMENT_CONTEXT
): CspViolation {
  return {
    at,
    disposition: String(event.disposition ?? ''),
    directive: event.effectiveDirective || event.violatedDirective || '',
    blockedURI: event.blockedURI ?? '',
    sourceFile: event.sourceFile ?? '',
    line: event.lineNumber ?? 0,
    column: event.columnNumber ?? 0,
    sample: event.sample ?? '',
    context
  };
}

const STRING_FIELDS = [
  'disposition',
  'directive',
  'blockedURI',
  'sourceFile',
  'sample',
  'context'
] as const;
const NUMBER_FIELDS = ['at', 'line', 'column'] as const;

/**
 * A forwarded entry, checked: the channel is open to any script of the origin,
 * so only something shaped like a violation is kept, and only its known fields.
 */
export function fromForwarded(data: unknown): CspViolation | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (STRING_FIELDS.some((key) => typeof record[key] !== 'string')) return null;
  if (NUMBER_FIELDS.some((key) => typeof record[key] !== 'number')) return null;
  const violation = {} as Record<string, string | number>;
  for (const key of [...STRING_FIELDS, ...NUMBER_FIELDS]) violation[key] = record[key] as never;
  return violation as unknown as CspViolation;
}

/** A fixed-size ring: pushing past capacity drops the oldest entry. */
export class ViolationRing {
  private readonly entries: CspViolation[] = [];

  constructor(private readonly capacity = CSP_VIOLATION_CAPACITY) {}

  push(violation: CspViolation): void {
    this.entries.push(violation);
    if (this.entries.length > this.capacity)
      this.entries.splice(0, this.entries.length - this.capacity);
  }

  /** A copy, oldest first. */
  list(): CspViolation[] {
    return this.entries.map((v) => ({ ...v }));
  }
}

const EXTENSION_SCHEMES = ['chrome-extension:', 'moz-extension:', 'safari-web-extension:'];

/**
 * Was this violation raised by the app's own code, rather than attributed to a
 * browser extension's scheme? FOR THE AUTOMATED SPEC ONLY (`e2e/csp.spec.ts`,
 * which loads no extension), and never a reason to dismiss an entry by hand.
 *
 * Chrome exempts an extension's own `chrome-extension:` loads from the page's
 * policy, so an extension-attributed violation that DOES fire is the extension
 * injecting inline script, style or media into the page itself — exactly what
 * an enforced policy would break for a Yomitan or Migaku user. When checking a
 * device by hand, every entry counts, extension ones included.
 */
export function isAppViolation(
  violation: Pick<CspViolation, 'sourceFile' | 'blockedURI'>
): boolean {
  return !EXTENSION_SCHEMES.some(
    (scheme) => violation.sourceFile.startsWith(scheme) || violation.blockedURI.startsWith(scheme)
  );
}

/** The part of a BroadcastChannel the buffer and the forwarder use. */
export interface ViolationChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

/** The channel, or null where there is none (an old browser, a bare test env). */
function openViolationChannel(): ViolationChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(CSP_VIOLATION_CHANNEL);
  // Node's BroadcastChannel (Vitest) would otherwise keep the process alive.
  (channel as unknown as { unref?: () => void }).unref?.();
  return channel;
}

let installed: ViolationRing | null = null;
let installedChannel: ViolationChannel | null = null;

/**
 * Start recording (once per page; later calls return the same buffer). The
 * listener is on the document in the capture phase, so an event dispatched at
 * an element is seen even if something stops its propagation. The app's
 * workers' violations arrive on {@link CSP_VIOLATION_CHANNEL}.
 */
export function installCspViolationBuffer(
  target: Pick<Document, 'addEventListener'> = document,
  global: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
  channel: ViolationChannel | null = openViolationChannel()
): ViolationRing {
  if (installed) {
    if (channel !== installedChannel) channel?.close();
    return installed;
  }
  const ring = new ViolationRing();
  target.addEventListener(
    'securitypolicyviolation',
    (event) => ring.push(toViolation(event as SecurityPolicyViolationEvent)),
    { capture: true }
  );
  channel?.addEventListener('message', (event) => {
    const violation = fromForwarded(event.data);
    if (violation) ring.push(violation);
  });
  global[CSP_VIOLATIONS_GLOBAL] = () => ring.list();
  installed = ring;
  installedChannel = channel;
  return ring;
}

/** The part of a worker's global the forwarder uses. */
export interface WorkerScopeLike {
  addEventListener(type: 'securitypolicyviolation', listener: (event: Event) => void): void;
  location?: { pathname: string };
}

/**
 * In an app worker, first thing: pass every violation that fires on the
 * worker's global to the document's buffer. The channel opens with the first
 * violation, so a worker that never violates never opens one.
 */
export function forwardWorkerCspViolations(
  scope: WorkerScopeLike = self as unknown as WorkerScopeLike,
  open: () => ViolationChannel | null = openViolationChannel
): void {
  const context = `worker ${scope.location?.pathname ?? '?'}`;
  let channel: ViolationChannel | null | undefined;
  scope.addEventListener('securitypolicyviolation', (event) => {
    if (channel === undefined) channel = open();
    channel?.postMessage(toViolation(event as SecurityPolicyViolationEvent, Date.now(), context));
  });
}

/** Tests only: forget the installed buffer. */
export function resetCspViolationBufferForTests(): void {
  installedChannel?.close();
  installedChannel = null;
  installed = null;
}
