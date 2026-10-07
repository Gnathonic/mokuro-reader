import { describe, expect, it, vi } from 'vitest';

// `volume-data.ts` imports the recorder, and many suites mock `dexie` with a
// bare factory. Loading the recorder must not evaluate the Dexie subclass.
vi.mock('dexie', () => ({}));

describe('record.ts module load', () => {
  it('imports without touching Dexie', async () => {
    const { recordEvent } = await import('./record');
    expect(typeof recordEvent).toBe('function');
  });
});
