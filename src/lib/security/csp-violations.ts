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
 * Violations raised inside a worker fire on that worker, not on the document,
 * and do not land here; the console still shows them.
 */

export const CSP_VIOLATION_CAPACITY = 100;

/** The global the buffer is read through (devtools, the e2e spec). */
export const CSP_VIOLATIONS_GLOBAL = '__mokuroCspViolations';

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

export function toViolation(event: ViolationEventLike, at = Date.now()): CspViolation {
  return {
    at,
    disposition: String(event.disposition ?? ''),
    directive: event.effectiveDirective || event.violatedDirective || '',
    blockedURI: event.blockedURI ?? '',
    sourceFile: event.sourceFile ?? '',
    line: event.lineNumber ?? 0,
    column: event.columnNumber ?? 0,
    sample: event.sample ?? ''
  };
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
 * Did the APP cause this violation, rather than a browser extension running in
 * the page? Extensions (Yomitan, Migaku, password managers) inject scripts and
 * styles into every page; their violations carry their own scheme in the
 * source file or the blocked URI, and are theirs to fix, not ours.
 */
export function isAppViolation(
  violation: Pick<CspViolation, 'sourceFile' | 'blockedURI'>
): boolean {
  return !EXTENSION_SCHEMES.some(
    (scheme) => violation.sourceFile.startsWith(scheme) || violation.blockedURI.startsWith(scheme)
  );
}

let installed: ViolationRing | null = null;

/**
 * Start recording (once per page; later calls return the same buffer). The
 * listener is on the document in the capture phase, so an event dispatched at
 * an element is seen even if something stops its propagation.
 */
export function installCspViolationBuffer(
  target: Pick<Document, 'addEventListener'> = document,
  global: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): ViolationRing {
  if (installed) return installed;
  const ring = new ViolationRing();
  target.addEventListener(
    'securitypolicyviolation',
    (event) => ring.push(toViolation(event as SecurityPolicyViolationEvent)),
    { capture: true }
  );
  global[CSP_VIOLATIONS_GLOBAL] = () => ring.list();
  installed = ring;
  return ring;
}

/** Tests only: forget the installed buffer. */
export function resetCspViolationBufferForTests(): void {
  installed = null;
}
