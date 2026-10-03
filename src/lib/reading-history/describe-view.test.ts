import { describe, expect, it } from 'vitest';
import { describeView, type ViewInputs } from './describe-view';

// Five pages with 10, 0, 30, 40, 50 characters.
const cumulative = [10, 10, 40, 80, 130];

function inputs(extra: Partial<ViewInputs>): ViewInputs {
  return {
    volume: 'vol-1',
    pageCharCumulative: cumulative,
    page: 1,
    continuous: false,
    scrollMode: 'vertical',
    showSecondPage: false,
    continuousRange: null,
    viewport: { w: 400, h: 800 },
    ...extra
  };
}

describe('describeView', () => {
  it('returns null before the volume or its pages are loaded', () => {
    expect(describeView(inputs({ volume: undefined }))).toBeNull();
    expect(describeView(inputs({ pageCharCumulative: [] }))).toBeNull();
  });

  it('describes a single page with its own chars and the chars before it', () => {
    expect(describeView(inputs({ page: 3 }))).toEqual({
      volume: 'vol-1',
      first_page: 3,
      last_page: 3,
      page_chars: [30],
      chars_before: 10,
      layout: 'single',
      orientation: 'portrait',
      viewport: { w: 400, h: 800 }
    });
  });

  it('describes a double spread as both pages, including a zero-char page', () => {
    const v = describeView(inputs({ page: 2, showSecondPage: true }));
    expect(v).toMatchObject({
      first_page: 2,
      last_page: 3,
      page_chars: [0, 30],
      layout: 'double'
    });
  });

  it('never runs past the last page', () => {
    const v = describeView(inputs({ page: 5, showSecondPage: true }));
    expect(v).toMatchObject({ first_page: 5, last_page: 5, page_chars: [50] });
    expect(describeView(inputs({ page: 9 }))).toMatchObject({ first_page: 5, last_page: 5 });
  });

  it('uses the continuous range when it contains the current page', () => {
    const v = describeView(
      inputs({ continuous: true, scrollMode: 'horizontal', page: 3, continuousRange: [2, 4] })
    );
    expect(v).toMatchObject({
      first_page: 2,
      last_page: 4,
      page_chars: [0, 30, 40],
      chars_before: 10,
      layout: 'continuous-h'
    });
  });

  it('falls back to the current page when the continuous range is stale or missing', () => {
    expect(
      describeView(inputs({ continuous: true, page: 5, continuousRange: [1, 2] }))
    ).toMatchObject({ first_page: 5, last_page: 5, layout: 'continuous-v' });
    expect(describeView(inputs({ continuous: true, page: 2 }))).toMatchObject({
      first_page: 2,
      last_page: 2
    });
  });

  it('reports landscape and rounds the viewport', () => {
    expect(describeView(inputs({ viewport: { w: 1280.4, h: 719.6 } }))).toMatchObject({
      orientation: 'landscape',
      viewport: { w: 1280, h: 720 }
    });
  });
});
