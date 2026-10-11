import { describe, expect, it } from 'vitest';

/**
 * The Devices block sits on the cloud screen, in the connected-provider
 * column after Storage (phase 4, Q1). Like `backup-all-reconcile.test.ts`,
 * this is asserted against the SOURCE: rendering CloudView means standing up
 * five providers, quota and queues just to see one child mounted. The block's
 * own behaviour is covered in `components/Devices/__tests__`.
 */
const sources = import.meta.glob('../CloudView.svelte', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;
const source = Object.values(sources)[0] ?? '';

describe('the Devices block on the cloud screen', () => {
  it('is imported', () => {
    expect(source).toContain(
      "import DevicesSettings from '$lib/components/Devices/DevicesSettings.svelte';"
    );
  });

  it('is mounted once, in the connected-provider column, after Storage and before About', () => {
    const connected = source.indexOf('{#if currentProvider}');
    const storage = source.indexOf('<h3 class="mb-2 font-semibold">Storage</h3>');
    const devices = source.indexOf('<DevicesSettings />');
    const about = source.indexOf('<!-- Provider info box -->');
    expect(connected).toBeGreaterThan(-1);
    expect(storage).toBeGreaterThan(connected);
    expect(devices).toBeGreaterThan(storage);
    expect(about).toBeGreaterThan(devices);
    expect(source.indexOf('<DevicesSettings />', devices + 1)).toBe(-1);
  });
});
