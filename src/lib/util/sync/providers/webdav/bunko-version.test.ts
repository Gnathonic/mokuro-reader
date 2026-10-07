import { describe, expect, it } from 'vitest';
import { bunkoSupportsHistory } from './bunko-version';

describe('bunkoSupportsHistory', () => {
  it.each(['0.7.1', '0.7.2', '0.8.0', '1.0.0', '0.7.1-beta.2', 'v0.7.1'])(
    '%s keeps history per user',
    (v) => {
      expect(bunkoSupportsHistory(v)).toBe(true);
    }
  );

  it.each([undefined, '', '0.7.0', '0.7.0-beta.1', '0.6.9', '0.5.3', 'garbage', '0.7'])(
    '%s does not',
    (v) => {
      expect(bunkoSupportsHistory(v)).toBe(false);
    }
  );
});
