import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CSP_VIOLATIONS_GLOBAL,
  CSP_VIOLATION_CAPACITY,
  CSP_VIOLATION_CHANNEL,
  ViolationRing,
  forwardWorkerCspViolations,
  fromForwarded,
  installCspViolationBuffer,
  isAppViolation,
  resetCspViolationBufferForTests,
  toViolation,
  type CspViolation,
  type ViolationChannel,
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
      sample: '',
      context: 'document'
    });
  });

  it('names the worker a forwarded violation fired in', () => {
    expect(toViolation(event(), 1, 'worker /w.js').context).toBe('worker /w.js');
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

  it('tells the automated spec which entries an extension’s scheme is attributed to', () => {
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

/** Two ends of one in-memory channel: what one posts, the other hears. */
function channelPair(): [ViolationChannel, ViolationChannel] {
  const listeners: [((e: MessageEvent) => void)[], ((e: MessageEvent) => void)[]] = [[], []];
  const end = (mine: 0 | 1): ViolationChannel => ({
    postMessage: (data) => {
      for (const l of listeners[mine === 0 ? 1 : 0]) l({ data } as MessageEvent);
    },
    addEventListener: (_type, listener) => listeners[mine].push(listener),
    close: vi.fn()
  });
  return [end(0), end(1)];
}

/** A worker global's stand-in: an event target with a location. */
function workerScope(pathname: string) {
  const target = new EventTarget();
  return Object.assign(target, { location: { pathname } });
}

describe('fromForwarded', () => {
  const valid = (): CspViolation => toViolation(event(), 5, 'worker /w.js');

  it('takes a forwarded violation as it is', () => {
    expect(fromForwarded(valid())).toEqual(valid());
  });

  it('keeps only the known fields', () => {
    expect(fromForwarded({ ...valid(), extra: 'x' })).toEqual(valid());
  });

  it('refuses anything not shaped like a violation (the channel is open to the origin)', () => {
    expect(fromForwarded(null)).toBeNull();
    expect(fromForwarded('inline')).toBeNull();
    expect(fromForwarded({ ...valid(), line: '3' })).toBeNull();
    const { context: _drop, ...noContext } = valid();
    expect(fromForwarded(noContext)).toBeNull();
  });
});

describe('a worker’s violations reach the document’s buffer', () => {
  it('forwards each one, with the worker it fired in', () => {
    const [pageEnd, workerEnd] = channelPair();
    const ring = installCspViolationBuffer(document, {}, pageEnd);
    const scope = workerScope('/_app/immutable/workers/unified-file-worker-x.js');
    forwardWorkerCspViolations(scope, () => workerEnd);

    scope.dispatchEvent(violationEvent({ effectiveDirective: 'script-src', blockedURI: 'eval' }));

    expect(ring.list()).toEqual([
      expect.objectContaining({
        directive: 'script-src',
        blockedURI: 'eval',
        context: 'worker /_app/immutable/workers/unified-file-worker-x.js'
      })
    ]);
  });

  it('opens the channel only with the first violation, and only once', () => {
    const [, workerEnd] = channelPair();
    const open = vi.fn(() => workerEnd);
    const scope = workerScope('/w.js');
    forwardWorkerCspViolations(scope, open);
    expect(open).not.toHaveBeenCalled();

    scope.dispatchEvent(violationEvent());
    scope.dispatchEvent(violationEvent());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('does nothing where there is no channel', () => {
    const scope = workerScope('/w.js');
    forwardWorkerCspViolations(scope, () => null);
    expect(() => scope.dispatchEvent(violationEvent())).not.toThrow();
  });

  it('ignores junk on the channel', () => {
    const [pageEnd, workerEnd] = channelPair();
    const ring = installCspViolationBuffer(document, {}, pageEnd);
    workerEnd.postMessage({ hello: 'world' });
    expect(ring.list()).toEqual([]);
  });

  it.skipIf(typeof BroadcastChannel === 'undefined')('over a real BroadcastChannel', async () => {
    const ring = installCspViolationBuffer(document, {});
    const scope = workerScope('/w.js');
    forwardWorkerCspViolations(scope);
    scope.dispatchEvent(violationEvent({ blockedURI: 'wasm-eval' }));
    await vi.waitFor(() => expect(ring.list().map((v) => v.blockedURI)).toEqual(['wasm-eval']));
    expect(CSP_VIOLATION_CHANNEL).toBe('mokuro-csp-violations');
  });
});
