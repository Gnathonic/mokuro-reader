// Vitest setup file for global test configuration
import { vi } from 'vitest';

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
