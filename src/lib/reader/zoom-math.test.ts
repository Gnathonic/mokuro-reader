import { describe, it, expect } from 'vitest';
import { screenToContent, computeScrollPosition, contentToScreen } from './zoom-math';

/**
 * Test setup: vertical scroll mode
 * - Viewport: 1920x1080
 * - Page: 1500x2000 (narrower than viewport)
 * - Pages centered with mx-auto inside wrapper
 * - Wrapper fills scroll container width (1920px layout)
 * - Wrapper offset: X=0, Y=540 (50vh centering spacer = 1080/2)
 * - Page is centered at X=210 to X=1710 inside the wrapper
 */
const VIEWPORT_W = 1920;
const VIEWPORT_H = 1080;
const PAGE_W = 1500;
const PAGE_H = 2000;
const WRAPPER_OFFSET_X = 0; // Wrapper starts at left edge
const WRAPPER_OFFSET_Y = VIEWPORT_H / 2; // 50vh centering spacer

// Page center X in the wrapper's content space
const PAGE_LEFT_IN_WRAPPER = (VIEWPORT_W - PAGE_W) / 2; // 210px (mx-auto centering)

describe('screenToContent', () => {
  it('converts screen center to content space at zoom 1', () => {
    // Wrapper visual left = -scrollLeft + wrapperOffset = 0
    const { contentX, contentY } = screenToContent(
      VIEWPORT_W / 2,
      VIEWPORT_H / 2, // screen center
      0,
      -500 + WRAPPER_OFFSET_Y, // wrapper rect (scrolled down 500px)
      1
    );
    // Content X should be 960 (center of 1920px wrapper)
    expect(contentX).toBe(960);
    // Content Y = (540 - (-500 + 540)) / 1 = (540 - 40) / 1 = 500
    expect(contentY).toBe(500);
  });

  it('converts click on page center at zoom 1', () => {
    // Click at center of the visible page
    // Page is at x=210 to x=1710 in wrapper. Center = 960.
    // Wrapper visual left = 0 (no horizontal scroll at zoom 1)
    const { contentX } = screenToContent(960, 500, 0, 0, 1);
    expect(contentX).toBe(960);
  });

  it('converts screen position at zoom 2', () => {
    // At zoom 2, wrapper visual left might be offset by scroll
    // If scrollLeft=960, wrapperRect.left = wrapperOffset - scrollLeft = 0 - 960 = -960
    const { contentX, contentY } = screenToContent(
      960,
      540, // screen center
      -960,
      -500, // wrapper rect position
      2
    );
    // contentX = (960 - (-960)) / 2 = 1920 / 2 = 960
    expect(contentX).toBe(960);
    // contentY = (540 - (-500)) / 2 = 1040 / 2 = 520
    expect(contentY).toBe(520);
  });
});

describe('computeScrollPosition', () => {
  it('centers content point at viewport center when zooming from 1 to 2', () => {
    // Content point at (960, 300) should end up at viewport center
    const { scrollLeft, scrollTop } = computeScrollPosition(
      960,
      300, // content point
      VIEWPORT_W / 2,
      VIEWPORT_H / 2, // target screen position (center)
      2, // zoom
      WRAPPER_OFFSET_X,
      WRAPPER_OFFSET_Y
    );

    // scrollLeft = 0 + 960*2 - 960 = 960
    expect(scrollLeft).toBe(960);
    // scrollTop = 540 + 300*2 - 540 = 600
    expect(scrollTop).toBe(600);
  });

  it('keeps content point at cursor position for wheel zoom', () => {
    // Cursor at (400, 300), content under cursor, keep it there
    const contentX = 400; // At zoom 1, content at x=400 in wrapper
    const { scrollLeft, scrollTop } = computeScrollPosition(
      contentX,
      200,
      400,
      300, // target = same as cursor (keep fixed)
      2,
      WRAPPER_OFFSET_X,
      WRAPPER_OFFSET_Y
    );

    // scrollLeft = 0 + 400*2 - 400 = 400
    expect(scrollLeft).toBe(400);
    // scrollTop = 540 + 200*2 - 300 = 640
    expect(scrollTop).toBe(640);
  });

  it('at zoom 1 with no offset, scroll is 0 when content center is at screen center', () => {
    const { scrollLeft, scrollTop } = computeScrollPosition(
      960,
      0,
      960,
      WRAPPER_OFFSET_Y,
      1,
      WRAPPER_OFFSET_X,
      WRAPPER_OFFSET_Y
    );
    expect(scrollLeft).toBe(0);
    expect(scrollTop).toBe(0);
  });
});

describe('contentToScreen (validation inverse)', () => {
  it('round-trips: screen->content->scroll->screen gives original position', () => {
    const clickX = 700;
    const clickY = 400;
    const currentZoom = 1;
    const wrapperVisualLeft = 0;
    const wrapperVisualTop = WRAPPER_OFFSET_Y - 200; // scrolled down 200px

    // Step 1: screen to content
    const { contentX, contentY } = screenToContent(
      clickX,
      clickY,
      wrapperVisualLeft,
      wrapperVisualTop,
      currentZoom
    );

    // Step 2: compute scroll for new zoom, target = screen center
    const targetZoom = 2;
    const { scrollLeft, scrollTop } = computeScrollPosition(
      contentX,
      contentY,
      VIEWPORT_W / 2,
      VIEWPORT_H / 2,
      targetZoom,
      WRAPPER_OFFSET_X,
      WRAPPER_OFFSET_Y
    );

    // Step 3: verify the content point appears at viewport center
    const result = contentToScreen(
      contentX,
      contentY,
      scrollLeft,
      scrollTop,
      targetZoom,
      WRAPPER_OFFSET_X,
      WRAPPER_OFFSET_Y
    );

    expect(result.screenX).toBeCloseTo(VIEWPORT_W / 2, 5);
    expect(result.screenY).toBeCloseTo(VIEWPORT_H / 2, 5);
  });

  it('round-trips for wheel zoom: content stays at cursor', () => {
    const cursorX = 1200;
    const cursorY = 600;
    const currentZoom = 1.5;
    // At zoom 1.5, wrapper rect depends on scroll
    const scrollLeft = 400;
    const scrollTop = 300;
    const wrapperVisualLeft = WRAPPER_OFFSET_X - scrollLeft; // 0 - 400 = -400
    const wrapperVisualTop = WRAPPER_OFFSET_Y - scrollTop; // 540 - 300 = 240

    // Step 1: screen to content
    const { contentX, contentY } = screenToContent(
      cursorX,
      cursorY,
      wrapperVisualLeft,
      wrapperVisualTop,
      currentZoom
    );

    // Step 2: compute scroll for new zoom, target = SAME screen position (cursor stays fixed)
    const targetZoom = 2;
    const { scrollLeft: newScrollLeft, scrollTop: newScrollTop } = computeScrollPosition(
      contentX,
      contentY,
      cursorX,
      cursorY, // target = cursor position (keep fixed)
      targetZoom,
      WRAPPER_OFFSET_X,
      WRAPPER_OFFSET_Y
    );

    // Step 3: verify the content point appears at cursor position
    const result = contentToScreen(
      contentX,
      contentY,
      newScrollLeft,
      newScrollTop,
      targetZoom,
      WRAPPER_OFFSET_X,
      WRAPPER_OFFSET_Y
    );

    expect(result.screenX).toBeCloseTo(cursorX, 5);
    expect(result.screenY).toBeCloseTo(cursorY, 5);
  });

  it('double-tap on right side of page zooms it to center', () => {
    // Click at x=1500 (right side of page which goes from 210 to 1710)
    const clickX = 1500;
    const clickY = 540;
    const currentZoom = 1;
    const wrapperVisualLeft = 0;
    const wrapperVisualTop = WRAPPER_OFFSET_Y; // At top of volume, scrollTop=0

    const { contentX, contentY } = screenToContent(
      clickX,
      clickY,
      wrapperVisualLeft,
      wrapperVisualTop,
      currentZoom
    );

    // contentX should be 1500 (in wrapper coordinates)
    expect(contentX).toBe(1500);

    const targetZoom = 2;
    const { scrollLeft, scrollTop } = computeScrollPosition(
      contentX,
      contentY,
      VIEWPORT_W / 2,
      VIEWPORT_H / 2,
      targetZoom,
      WRAPPER_OFFSET_X,
      WRAPPER_OFFSET_Y
    );

    // Verify: content point at center
    const result = contentToScreen(
      contentX,
      contentY,
      scrollLeft,
      scrollTop,
      targetZoom,
      WRAPPER_OFFSET_X,
      WRAPPER_OFFSET_Y
    );

    expect(result.screenX).toBeCloseTo(VIEWPORT_W / 2, 5);
    expect(result.screenY).toBeCloseTo(VIEWPORT_H / 2, 5);

    // scrollLeft should be positive (scrolled right to show right side of page)
    expect(scrollLeft).toBe(0 + 1500 * 2 - 960); // = 2040
    expect(scrollLeft).toBeGreaterThan(0);
  });

  it('double-tap on left side of page zooms it to center', () => {
    const clickX = 300;
    const clickY = 540;

    const { contentX } = screenToContent(clickX, 540, 0, WRAPPER_OFFSET_Y, 1);
    expect(contentX).toBe(300);

    const { scrollLeft } = computeScrollPosition(
      contentX,
      0,
      VIEWPORT_W / 2,
      VIEWPORT_H / 2,
      2,
      WRAPPER_OFFSET_X,
      WRAPPER_OFFSET_Y
    );

    // scrollLeft = 0 + 300*2 - 960 = -360
    // Negative = scroll container clamps to 0, page appears right of center
    // This is correct — the left edge of content IS to the left of where we can scroll
    expect(scrollLeft).toBe(-360);

    const result = contentToScreen(300, 0, Math.max(0, scrollLeft), 0, 2, 0, WRAPPER_OFFSET_Y);
    // With clamped scrollLeft=0, content at 300*2=600, screen position = 600
    // Not centered (960), but as close as scroll bounds allow
    expect(result.screenX).toBe(600);
  });
});
