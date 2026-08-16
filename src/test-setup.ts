// Vitest setup file for global test configuration
import { beforeEach, vi } from 'vitest';

// Polyfill Blob.arrayBuffer() for jsdom environment
// jsdom's Blob doesn't implement arrayBuffer() method which is needed by @zip.js/zip.js
if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(reader.result);
        } else {
          reject(new Error('Failed to read Blob as ArrayBuffer'));
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

// Polyfill Blob.text() for jsdom environment
// jsdom's Blob doesn't implement text(), needed by sync code/tests that read
// uploaded JSON payloads back out of a Blob.
if (typeof Blob !== 'undefined' && !Blob.prototype.text) {
  Blob.prototype.text = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('Failed to read Blob as text'));
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

// Polyfill the <dialog> modal API for jsdom environment
// jsdom does not implement showModal()/show()/close(); flowbite-svelte's Modal calls
// showModal() as soon as it mounts, so any component test rendering a modal throws
// without this shim.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.show = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, returnValue?: string) {
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event('close'));
  };
}

// Stub the Web Animations API for jsdom environment
// jsdom has no Element.animate(); Svelte 5 drives transitions through it, so rendering
// any component with a transition (flowbite's Modal) throws without this.
if (typeof Element !== 'undefined' && !Element.prototype.animate) {
  Element.prototype.animate = function () {
    const animation = {
      currentTime: 0,
      startTime: 0,
      playState: 'finished',
      playbackRate: 1,
      effect: null,
      onfinish: null as null | (() => void),
      oncancel: null as null | (() => void),
      finished: Promise.resolve(),
      play() {},
      pause() {},
      reverse() {},
      cancel() {},
      finish() {
        animation.onfinish?.();
      },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true
    };
    // Transitions are not what component tests assert on — settle immediately, after the
    // caller has had a chance to attach onfinish.
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
}

// Polyfill window.matchMedia for jsdom environment
// Required for Svelte components that use media queries (e.g., Flowbite components)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // Deprecated but still used by some libraries
    removeListener: vi.fn(), // Deprecated but still used by some libraries
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
});

function createStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    }
  };
}

function ensureStorageApi(storage: unknown) {
  return !!(
    storage &&
    typeof (storage as { getItem?: unknown }).getItem === 'function' &&
    typeof (storage as { setItem?: unknown }).setItem === 'function' &&
    typeof (storage as { removeItem?: unknown }).removeItem === 'function' &&
    typeof (storage as { clear?: unknown }).clear === 'function'
  );
}

function installStorageMocksIfNeeded() {
  if (!ensureStorageApi(window.localStorage)) {
    const mock = createStorageMock();
    Object.defineProperty(window, 'localStorage', { configurable: true, value: mock });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: mock });
  }

  if (!ensureStorageApi(window.sessionStorage)) {
    const mock = createStorageMock();
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: mock });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: mock });
  }
}

// Ensure valid storage APIs exist before test modules are evaluated.
installStorageMocksIfNeeded();

// Some tests mutate storage globals; repair before each test case.
beforeEach(() => {
  installStorageMocksIfNeeded();
});

// Mock Worker for jsdom environment
// Web Workers aren't available in jsdom, but some modules import them
class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(_scriptURL: string | URL) {
    // No-op constructor
  }

  postMessage(_message: any) {
    // No-op - tests should mock specific worker behavior if needed
  }

  terminate() {
    // No-op
  }

  addEventListener(_type: string, _listener: EventListener) {
    // No-op
  }

  removeEventListener(_type: string, _listener: EventListener) {
    // No-op
  }

  dispatchEvent(_event: Event): boolean {
    return true;
  }
}

// @ts-expect-error - Worker type mismatch is expected for mock
globalThis.Worker = MockWorker;
