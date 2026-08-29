import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

// The cover pipeline itself (fetch, dedupe, delivery) is exercised in
// `cover-service.test.ts` against a real Dexie; this component's own job —
// tested here — is just the object-URL lifecycle over `volume.thumbnail`
// (which the SERVICE delivers by writing to the row, not to this component)
// plus asking for a cover exactly when `isCoverFetchTarget` says to.
const { requestCover, isCoverFetchTarget } = vi.hoisted(() => ({
  requestCover: vi.fn(),
  isCoverFetchTarget: vi.fn(() => true)
}));
vi.mock('$lib/catalog/cover-service', () => ({ requestCover, isCoverFetchTarget }));

import { tick } from 'svelte';
import PlaceholderThumbnail from '../PlaceholderThumbnail.svelte';
import { installIntersectionObserverStub } from '$lib/catalog/__tests__/intersection-observer-stub';
import type { VolumeMetadata } from '$lib/types';

function volume(uuid: string, overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Vol 1',
    page_count: 10,
    isPlaceholder: true,
    cloudThumbnailFileId: `thumb-${uuid}`,
    ...overrides
  } as VolumeMetadata;
}

describe('PlaceholderThumbnail cover lifetime', () => {
  const originalCreate = globalThis.URL.createObjectURL;
  const originalRevoke = globalThis.URL.revokeObjectURL;
  let created: string[] = [];
  let revoked: string[] = [];

  beforeEach(() => {
    created = [];
    revoked = [];
    requestCover.mockClear();
    isCoverFetchTarget.mockClear();
    isCoverFetchTarget.mockReturnValue(true);
    globalThis.URL.createObjectURL = vi.fn(() => {
      const url = `blob:cover-${created.length + 1}`;
      created.push(url);
      return url;
    }) as unknown as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.URL.createObjectURL = originalCreate;
    globalThis.URL.revokeObjectURL = originalRevoke;
  });

  it('renders the row-delivered thumbnail as an object URL', async () => {
    const cover = new File([], 'cover.jpg', { type: 'image/jpeg' });
    const { container } = render(PlaceholderThumbnail, {
      props: { volume: volume('c-1', { thumbnail: cover }) }
    });
    await tick();

    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-1');
  });

  it('stops showing a cover whose URL it revoked when the volume changes', async () => {
    // The card reuses one PlaceholderThumbnail across volumes (a re-sort, a page of
    // results). Revoking without clearing the state leaves the <img> pointing at a dead
    // blob URL: a broken-image icon where the next volume's placeholder belongs.
    const cover = new File([], 'cover.jpg', { type: 'image/jpeg' });
    const { container, rerender } = render(PlaceholderThumbnail, {
      props: { volume: volume('c-1', { thumbnail: cover }) }
    });
    await tick();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-1');

    await rerender({ volume: volume('c-2') }); // no thumbnail: still session-cache-less
    await tick();

    expect(revoked).toEqual(['blob:cover-1']);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('No thumbnail');
  });

  it('asks the service for a cover when the volume is a fetch target', async () => {
    render(PlaceholderThumbnail, { props: { volume: volume('c-3') } });
    await tick();

    expect(requestCover).toHaveBeenCalledWith(
      expect.objectContaining({ volume_uuid: 'c-3' }),
      expect.any(Function)
    );
  });

  it('does not ask when the volume is not a fetch target (e.g. already has a fresh thumbnail)', async () => {
    isCoverFetchTarget.mockReturnValue(false);
    render(PlaceholderThumbnail, {
      props: { volume: volume('c-4', { thumbnail: new File([], 'cover.jpg') }) }
    });
    await tick();

    expect(requestCover).not.toHaveBeenCalled();
  });

  it('PIN: a catalog re-derive that hands back an equivalent-but-new File for the SAME cover never churns the object URL', async () => {
    // A whole-table liveQuery re-derive (any row anywhere committing, not
    // necessarily this one) gives every mounted card a BRAND NEW `volume`
    // object, and IndexedDB reads give a brand new `File` instance per read
    // even for byte-identical data — object identity alone would make this
    // component tear down and recreate its object URL (forcing the browser
    // to re-decode/re-paint) on every unrelated re-derive. `size` +
    // `lastModified` is what a structured-clone round trip preserves, so two
    // reads of the SAME stored cover carry the same key.
    const lastModified = 1_700_000_000_000;
    const coverA = new File(['same-bytes'], 'cover.jpg', { type: 'image/jpeg', lastModified });
    const { container, rerender } = render(PlaceholderThumbnail, {
      props: { volume: volume('c-5', { thumbnail: coverA }) }
    });
    await tick();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-1');

    // A DIFFERENT File instance, same uuid, same size, same lastModified —
    // exactly what a fresh IndexedDB read of the unchanged row looks like.
    const coverAAgain = new File(['same-bytes'], 'cover.jpg', {
      type: 'image/jpeg',
      lastModified
    });
    await rerender({ volume: volume('c-5', { thumbnail: coverAAgain }) });
    await tick();

    expect(created).toEqual(['blob:cover-1']); // no second createObjectURL call
    expect(revoked).toEqual([]); // the live URL was never revoked
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-1');
  });

  it('still swaps the object URL for a GENUINELY new cover on the same uuid (a self-heal overwrite)', async () => {
    const coverOld = new File(['old'], 'cover.jpg', {
      type: 'image/jpeg',
      lastModified: 1_700_000_000_000
    });
    const { container, rerender } = render(PlaceholderThumbnail, {
      props: { volume: volume('c-6', { thumbnail: coverOld }) }
    });
    await tick();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-1');

    const coverNew = new File(['new-bytes-different-size'], 'cover.jpg', {
      type: 'image/jpeg',
      lastModified: 1_700_000_005_000 // a later fetch
    });
    await rerender({ volume: volume('c-6', { thumbnail: coverNew }) });
    await tick();

    expect(created).toEqual(['blob:cover-1', 'blob:cover-2']);
    expect(revoked).toEqual(['blob:cover-1']);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-2');
  });
});

/**
 * THE VIEWPORT GATE.
 *
 * The catalog renders every series card at once — 1,027 of them and a 161,961 px page on
 * the measured library — and each one asked for the covers of the ~4 volumes its stack
 * draws the moment it mounted: ~4,347 cover requests, 134 MB, a 12.2-second burst, for a
 * screenful of maybe six cards. Every cover-drawing surface now shares one gate
 * (`cover-claims.svelte.ts` + `cover-viewport.ts`): nothing is asked for until the
 * surface comes within a screenful of the viewport.
 *
 * jsdom has no `IntersectionObserver`, and the gate deliberately opens when there is
 * none, so these tests install one and assert that it was actually observed — an
 * unstubbed run would pass every one of them vacuously.
 */
describe('PlaceholderThumbnail asks for a cover only once it is near the viewport', () => {
  let observer: ReturnType<typeof installIntersectionObserverStub>;

  beforeEach(() => {
    requestCover.mockClear();
    isCoverFetchTarget.mockReturnValue(true);
    observer = installIntersectionObserverStub({ autoIntersect: false });
  });

  afterEach(() => {
    cleanup();
    observer.restore();
  });

  it('asks for nothing while it is still below the fold', async () => {
    render(PlaceholderThumbnail, { props: { volume: volume('far-1') } });
    await tick();
    await tick();

    expect(requestCover).not.toHaveBeenCalled();
    // Not vacuous: the box really did arm the gate, it just has not opened.
    expect(observer.gates).toHaveLength(1);
  });

  it('asks as soon as it comes within the prefetch margin', async () => {
    render(PlaceholderThumbnail, { props: { volume: volume('near-1') } });
    await tick();
    expect(requestCover).not.toHaveBeenCalled();

    observer.gates[0].emit(true); // scrolled into the band
    await tick();

    expect(requestCover).toHaveBeenCalledTimes(1);
    expect(requestCover).toHaveBeenCalledWith(
      expect.objectContaining({ volume_uuid: 'near-1' }),
      expect.any(Function)
    );
  });

  it('does not ask again when it leaves the viewport and comes back', async () => {
    // The gate LATCHES: a card scrolled past and returned to has already been asked for,
    // and `cover-service.ts`'s settled ledger (keyed by account scope + uuid) would refuse
    // a second fetch anyway — see its own suite. Re-arming here would put a fresh request
    // storm one scroll-up away from the user.
    render(PlaceholderThumbnail, { props: { volume: volume('return-1') } });
    await tick();

    observer.gates[0].emit(true);
    await tick();
    expect(requestCover).toHaveBeenCalledTimes(1);

    observer.gates[0].emit(false); // scrolled away
    await tick();
    observer.gates[0].emit(true); // and back
    await tick();

    expect(requestCover).toHaveBeenCalledTimes(1);
  });
});
