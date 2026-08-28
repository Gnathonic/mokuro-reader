import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { installIntersectionObserverStub } from '$lib/catalog/__tests__/intersection-observer-stub';

/**
 * THE SURFACE THAT FORGETS `use:gate`.
 *
 * Every cover-drawing surface in the app today remembers it, so nothing in the
 * repo can render the mistake — which is exactly the problem: the next surface
 * to pass `targets` gets no help at all. In jsdom with no observer installed the
 * gate opens synchronously (`cover-viewport.ts`: NO OBSERVER, NO GATE), so that
 * surface's own tests would pass while a browser silently requested nothing for
 * it, forever, with no error to notice.
 */

const { requestCoverMock, isCoverFetchTargetMock } = vi.hoisted(() => ({
  requestCoverMock: vi.fn(),
  isCoverFetchTargetMock: vi.fn(() => true)
}));
vi.mock('$lib/catalog/cover-service', () => ({
  requestCover: (...args: Parameters<typeof requestCoverMock>) => requestCoverMock(...args),
  isCoverFetchTarget: (...args: unknown[]) =>
    (isCoverFetchTargetMock as unknown as (...a: unknown[]) => boolean)(...args)
}));

// The resolver has its own suites; here a claim just needs to be acquirable.
vi.mock('$lib/catalog/cover-resolver', () => ({
  acquireCover: () => ({
    subscribe: () => () => {},
    release: () => {}
  })
}));

vi.mock('$lib/catalog/account-scope-store', () => ({
  activeAccountScopeStore: {
    subscribe(fn: (value: string | null) => void) {
      fn('webdav:https://host/dav|nathan');
      return () => {};
    }
  }
}));

import CoverClaimsHost from '$lib/catalog/__tests__/fixtures/CoverClaimsHost.svelte';
import type { VolumeMetadata } from '$lib/types';

function cloudVolume(over: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'cloud-uuid-1',
    series_uuid: 'series-uuid',
    series_title: 'Dr Stone',
    volume_title: 'Volume 01',
    mokuro_version: 'unknown',
    page_count: 10,
    character_count: 0,
    page_char_counts: [],
    isPlaceholder: true,
    cloudPath: 'Dr Stone/Volume 01.cbz',
    ...over
  } as VolumeMetadata;
}

let observer: ReturnType<typeof installIntersectionObserverStub>;
let warn: ReturnType<typeof vi.spyOn>;

/** Past the effect flush. */
async function settle(): Promise<void> {
  await tick();
  await tick();
}

beforeEach(() => {
  requestCoverMock.mockClear();
  isCoverFetchTargetMock.mockReturnValue(true);
  // Held SHUT: the whole question is whether a gate was ever armed, and an
  // auto-opening stub answers it for the surface.
  observer = installIntersectionObserverStub({ autoIntersect: false });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  observer.restore();
  warn.mockRestore();
});

const ungatedWarning = /passed `targets` but never attached `use:gate`/;

describe('a surface that asks for covers but never arms its gate', () => {
  it('says so, instead of silently requesting nothing for the rest of the session', async () => {
    render(CoverClaimsHost, { props: { volumes: [cloudVolume()], attachGate: false } });
    await settle();

    // Non-vacuous: this surface really does have something to ask for, and really did
    // not ask — the warning is the only signal that would ever reach a developer.
    expect(observer.gates).toHaveLength(0);
    expect(requestCoverMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(String).join('\n')).toMatch(ungatedWarning);
  });

  it('warns once, not once per re-render', async () => {
    const { rerender } = render(CoverClaimsHost, {
      props: { volumes: [cloudVolume()], attachGate: false }
    });
    await settle();
    await rerender({ volumes: [cloudVolume({ volume_uuid: 'cloud-uuid-2' })], attachGate: false });
    await settle();

    expect(warn.mock.calls.filter((call) => ungatedWarning.test(String(call[0])))).toHaveLength(1);
  });
});

describe('the surfaces that are wired correctly stay quiet', () => {
  it('a surface WITH `use:gate` never warns — it just waits for the viewport', async () => {
    render(CoverClaimsHost, { props: { volumes: [cloudVolume()] } });
    await settle();

    // Armed and shut, which is the correct off-screen state and must not look like the
    // defect above.
    expect(observer.gates).toHaveLength(1);
    expect(requestCoverMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(String).join('\n')).not.toMatch(ungatedWarning);

    observer.gates[0].emit(true);
    await settle();
    expect(requestCoverMock).toHaveBeenCalledTimes(1);
  });

  it('a PAINT-ONLY surface (no `targets` at all) never warns', async () => {
    // `CatalogListItem`'s shape: it claims and draws, it has never asked for anything,
    // and it renders no gate node. That is not the defect.
    render(CoverClaimsHost, {
      props: { volumes: [cloudVolume()], withTargets: false, attachGate: false }
    });
    await settle();

    expect(warn.mock.calls.map(String).join('\n')).not.toMatch(ungatedWarning);
  });

  it('a surface whose targets resolve to nothing never warns', async () => {
    // `VolumeItem`'s grid variant: `targets` is supplied but yields an empty list, and
    // the gate node lives only in the list branch. Nothing is being missed.
    isCoverFetchTargetMock.mockReturnValue(false);

    render(CoverClaimsHost, { props: { volumes: [cloudVolume()], attachGate: false } });
    await settle();

    expect(warn.mock.calls.map(String).join('\n')).not.toMatch(ungatedWarning);
  });
});

describe('every request carries a live still-near-viewport probe', () => {
  it('binds the probe to the gated element and answers from its CURRENT rect', async () => {
    render(CoverClaimsHost, { props: { volumes: [cloudVolume()] } });
    await settle();
    observer.gates[0].emit(true);
    await settle();

    expect(requestCoverMock).toHaveBeenCalledTimes(1);
    const probe = requestCoverMock.mock.calls[0][1] as (() => boolean) | undefined;
    expect(typeof probe).toBe('function');

    // jsdom rects are all zeros — indistinguishable from a detached node, so
    // the probe answers "not near"...
    expect(probe!()).toBe(false);

    // ...and the SAME probe answers from the element's rect at ASK time, not
    // from a snapshot: give the gated element an on-screen rect and it flips.
    const node = observer.gates[0].target as HTMLElement;
    const originalRect = node.getBoundingClientRect.bind(node);
    node.getBoundingClientRect = () =>
      ({ top: 10, bottom: 110, left: 10, right: 110, width: 100, height: 100 }) as DOMRect;
    expect(probe!()).toBe(true);
    node.getBoundingClientRect = originalRect;
    expect(probe!()).toBe(false);
  });
});
