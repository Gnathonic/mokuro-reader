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
