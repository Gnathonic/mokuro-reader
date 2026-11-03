import { afterEach, describe, expect, it } from 'vitest';
import {
  CSP_VIOLATIONS_GLOBAL,
  CSP_VIOLATION_CAPACITY,
  ViolationRing,
  installCspViolationBuffer,
  isAppViolation,
  resetCspViolationBufferForTests,
  toViolation,
  type CspViolation,
  type ViolationEventLike
} from './csp-violations';

const event = (over: Partial<ViolationEventLike> = {}): ViolationEventLike => ({
  disposition: 'enforce',
  effectiveDirective: 'script-src-elem',
  violatedDirective: 'script-src-elem',
  blockedURI: 'https://evil.example/x.js',
  sourceFile: 'http://localhost/_app/immutable/chunks/a.js',
  lineNumber: 3,
  columnNumber: 7,
  sample: '',
  ...over
});

/** A `securitypolicyviolation` jsdom can dispatch: it has no such constructor. */
function violationEvent(over: Partial<ViolationEventLike> = {}): Event {
  return Object.assign(new Event('securitypolicyviolation', { bubbles: true }), event(over));
}

afterEach(() => {
  resetCspViolationBufferForTests();
  delete (globalThis as Record<string, unknown>)[CSP_VIOLATIONS_GLOBAL];
});

describe('toViolation', () => {
  it('keeps what a reader of the buffer needs to find the cause', () => {
    expect(toViolation(event(), 42)).toEqual({
      at: 42,
      disposition: 'enforce',
      directive: 'script-src-elem',
      blockedURI: 'https://evil.example/x.js',
      sourceFile: 'http://localhost/_app/immutable/chunks/a.js',
      line: 3,
      column: 7,
      sample: ''
    });
  });

  it('falls back to the violated directive when there is no effective one', () => {
    expect(toViolation(event({ effectiveDirective: '' })).directive).toBe('script-src-elem');
  });
});

describe('ViolationRing', () => {
  const v = (n: number): CspViolation => toViolation(event({ lineNumber: n }), n);

  it('keeps the newest entries, oldest first, once past capacity', () => {
    const ring = new ViolationRing(3);
    for (let n = 1; n <= 5; n++) ring.push(v(n));
    expect(ring.list().map((x) => x.line)).toEqual([3, 4, 5]);
  });

  it('hands out copies: a reader cannot rewrite the record', () => {
    const ring = new ViolationRing();
    ring.push(v(1));
    ring.list()[0].line = 99;
    ring.list().pop();
    expect(ring.list().map((x) => x.line)).toEqual([1]);
  });

  it('defaults to a hundred entries', () => {
    const ring = new ViolationRing();
    for (let n = 0; n < CSP_VIOLATION_CAPACITY + 10; n++) ring.push(v(n));
    expect(ring.list()).toHaveLength(CSP_VIOLATION_CAPACITY);
  });
});

describe('isAppViolation', () => {
  it('counts the app’s own violations', () => {
    expect(isAppViolation(toViolation(event()))).toBe(true);
    expect(isAppViolation({ sourceFile: '', blockedURI: 'inline' })).toBe(true);
  });

  it('leaves out what an extension injected (Yomitan, Migaku, …)', () => {
    expect(
      isAppViolation({ sourceFile: 'chrome-extension://abc/content.js', blockedURI: 'inline' })
    ).toBe(false);
    expect(isAppViolation({ sourceFile: '', blockedURI: 'moz-extension://abc/popup.html' })).toBe(
      false
    );
    expect(
      isAppViolation({ sourceFile: 'safari-web-extension://abc/a.js', blockedURI: 'eval' })
    ).toBe(false);
  });
});

describe('installCspViolationBuffer', () => {
  it('records the document’s violations and exposes them through the global, nowhere else', () => {
    const ring = installCspViolationBuffer();
    document.body.dispatchEvent(violationEvent({ blockedURI: 'inline', sourceFile: '' }));

    const read = (globalThis as Record<string, unknown>)[
      CSP_VIOLATIONS_GLOBAL
    ] as () => CspViolation[];
    expect(read().map((x) => x.blockedURI)).toEqual(['inline']);
    expect(ring.list()).toEqual(read());
  });

  it('sees an event even when the target stops its propagation', () => {
    installCspViolationBuffer();
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.addEventListener('securitypolicyviolation', (e) => e.stopPropagation());
    el.dispatchEvent(violationEvent());
    el.remove();

    const read = (globalThis as Record<string, unknown>)[
      CSP_VIOLATIONS_GLOBAL
    ] as () => CspViolation[];
    expect(read()).toHaveLength(1);
  });

  it('installs once: a second call returns the same buffer and adds no listener', () => {
    const first = installCspViolationBuffer();
    const second = installCspViolationBuffer();
    expect(second).toBe(first);
    document.body.dispatchEvent(violationEvent());
    expect(first.list()).toHaveLength(1);
  });
});
