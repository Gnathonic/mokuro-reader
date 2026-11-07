import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '$lib/types';

const updateProgress = vi.fn();
const recordActivity = vi.fn();
vi.mock('$lib/settings/volume-data', () => ({ updateProgress }));
vi.mock('$lib/util/activity-tracker', () => ({ activityTracker: { recordActivity } }));

const { recordPagedPageView } = await import('./paged-progress');

function pageWith(...lines: string[]): Page {
  return {
    version: '0.2.5',
    img_width: 100,
    img_height: 100,
    img_path: 'p.jpg',
    blocks: [{ box: [0, 0, 10, 10], vertical: true, font_size: 10, lines }]
  } as unknown as Page;
}

const PAGES = [pageWith('あい'), pageWith('うえお'), pageWith('か'), pageWith('きく')];

beforeEach(() => {
  updateProgress.mockClear();
  recordActivity.mockClear();
});

describe('recordPagedPageView', () => {
  it('moves the progress to the page with the characters read up to it', () => {
    recordPagedPageView('vol', 2, PAGES);
    expect(updateProgress).toHaveBeenCalledWith('vol', 2, 5, false);
    expect(recordActivity).toHaveBeenCalledTimes(1);
  });

  it('counts the volume finished on its last page and on the one before', () => {
    recordPagedPageView('vol', 3, PAGES);
    expect(updateProgress).toHaveBeenLastCalledWith('vol', 3, 6, true);
    recordPagedPageView('vol', 4, PAGES);
    expect(updateProgress).toHaveBeenLastCalledWith('vol', 4, 8, true);
  });
});
