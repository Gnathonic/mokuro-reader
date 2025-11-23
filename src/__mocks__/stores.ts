/**
 * Store mocking utilities for testing Svelte stores
 */

import { writable, derived, readable, get, type Writable, type Readable } from 'svelte/store';
import { vi } from 'vitest';

// ============================================================================
// Mock Store Factories
// ============================================================================

/**
 * Create a mock writable store with testing utilities
 */
export function mockWritable<T>(initial: T) {
  const store = writable(initial);
  const originalSet = store.set;
  const originalUpdate = store.update;

  // Track calls for assertions
  const setCalls: T[] = [];
  const updateCalls: Array<(value: T) => T> = [];

  const mockStore = {
    ...store,
    set: (value: T) => {
      setCalls.push(value);
      originalSet(value);
    },
    update: (updater: (value: T) => T) => {
      updateCalls.push(updater);
      originalUpdate(updater);
    },
    // Testing utilities
    reset: () => {
      originalSet(initial);
      setCalls.length = 0;
      updateCalls.length = 0;
    },
    getValue: () => get(store),
    getSetCalls: () => [...setCalls],
    getUpdateCalls: () => [...updateCalls],
    wasSet: () => setCalls.length > 0,
    wasUpdated: () => updateCalls.length > 0
  };

  return mockStore;
}

/**
 * Create a mock readable store
 */
export function mockReadable<T>(initial: T) {
  let currentValue = initial;
  const subscribers = new Set<(value: T) => void>();

  const store: Readable<T> & {
    _set: (value: T) => void;
    getValue: () => T;
  } = {
    subscribe: (run) => {
      subscribers.add(run);
      run(currentValue);
      return () => {
        subscribers.delete(run);
      };
    },
    // Hidden setter for tests to change value
    _set: (value: T) => {
      currentValue = value;
      subscribers.forEach((fn) => fn(value));
    },
    getValue: () => currentValue
  };

  return store;
}

/**
 * Create a mock derived store that can be manually controlled
 */
export function mockDerived<T>(initial: T) {
  return mockReadable(initial);
}

// ============================================================================
// Store Module Mocking Helpers
// ============================================================================

/**
 * Create a complete mock of the settings stores
 */
export function createSettingsMocks() {
  return {
    profiles: mockWritable([{ id: 'default', name: 'Default', settings: {} }]),
    currentProfile: mockWritable('default'),
    settings: mockReadable({}),
    currentSettings: mockReadable({})
  };
}

/**
 * Create a complete mock of the volume stores
 */
export function createVolumeMocks() {
  return {
    volumes: mockWritable<Record<string, any>>({}),
    progress: mockDerived<Record<string, number>>({}),
    volumeSettings: mockDerived<Record<string, any>>({}),
    totalStats: mockDerived({
      totalTime: 0,
      totalChars: 0,
      volumesCompleted: 0
    })
  };
}

/**
 * Create a mock for miscSettings store
 */
export function createMiscSettingsMock() {
  return mockWritable({
    theme: 'system',
    compactCatalog: false,
    idleTimeoutMinutes: 10,
    showReadingSpeed: true,
    enableCloudSync: false
  });
}

// ============================================================================
// Vitest Mock Helpers
// ============================================================================

/**
 * Helper to create a vi.mock factory for a store module
 *
 * Usage:
 * ```typescript
 * vi.mock('$lib/settings/settings', () =>
 *   createStoreMockFactory({
 *     profiles: mockWritable([]),
 *     currentProfile: mockWritable('default')
 *   })
 * );
 * ```
 */
export function createStoreMockFactory(stores: Record<string, any>) {
  return stores;
}

/**
 * Reset all mock stores in a collection
 */
export function resetAllMocks(mocks: Record<string, any>) {
  Object.values(mocks).forEach((mock) => {
    if (mock && typeof mock.reset === 'function') {
      mock.reset();
    }
  });
}

// ============================================================================
// Async Store Utilities
// ============================================================================

/**
 * Wait for a store to emit a specific value
 */
export function waitForStoreValue<T>(
  store: Readable<T>,
  predicate: (value: T) => boolean,
  timeout = 1000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Store did not emit expected value within ${timeout}ms`));
    }, timeout);

    const unsubscribe = store.subscribe((value) => {
      if (predicate(value)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      }
    });
  });
}

/**
 * Collect store emissions over time
 */
export function collectStoreEmissions<T>(
  store: Readable<T>,
  count: number,
  timeout = 1000
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const emissions: T[] = [];

    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(`Only collected ${emissions.length}/${count} emissions within ${timeout}ms`)
      );
    }, timeout);

    const unsubscribe = store.subscribe((value) => {
      emissions.push(value);
      if (emissions.length >= count) {
        clearTimeout(timer);
        unsubscribe();
        resolve(emissions);
      }
    });
  });
}

// ============================================================================
// SvelteKit App Stores Mocks
// ============================================================================

/**
 * Create mock SvelteKit page store
 */
export function mockPageStore(
  overrides: Partial<{
    url: URL;
    params: Record<string, string>;
    route: { id: string | null };
    status: number;
    error: Error | null;
    data: Record<string, any>;
    form: any;
  }> = {}
) {
  return mockReadable({
    url: new URL('http://localhost'),
    params: {},
    route: { id: '/' },
    status: 200,
    error: null,
    data: {},
    form: null,
    ...overrides
  });
}

/**
 * Create mock SvelteKit navigating store
 */
export function mockNavigatingStore() {
  return mockReadable<null | {
    from: { url: URL; params: Record<string, string>; route: { id: string | null } };
    to: { url: URL; params: Record<string, string>; route: { id: string | null } };
    type: 'link' | 'popstate' | 'goto';
  }>(null);
}
