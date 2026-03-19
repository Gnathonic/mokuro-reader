import { test, expect } from '@playwright/test';

/**
 * E2E zoom tests with multi-page volume.
 * Tests zoom at various positions throughout the volume to catch
 * issues that only appear on non-first pages.
 */

test.describe('Multi-page vertical scroll zoom', () => {
	test.beforeEach(async ({ page }) => {
		// Create a 10-page test volume with distinct colored pages
		await page.setContent(`
			<style>
				* { margin: 0; padding: 0; box-sizing: border-box; }
				body { overflow: hidden; background: #000; }
				#outer { position: fixed; inset: 0; }
				#scroll { width: 100%; height: 100%; overflow: auto; }
				.spacer-top, .spacer-bottom { height: 50vh; }
				#wrapper { transform-origin: top left; }
				.page {
					width: 400px; height: 600px; margin: 0 auto;
					position: relative; overflow: hidden;
					display: flex; align-items: center; justify-content: center;
					font-size: 48px; color: white; font-family: monospace;
				}
			</style>
			<div id="outer">
				<div id="scroll">
					<div id="spacer">
						<div class="spacer-top"></div>
						<div id="wrapper">
							${Array.from({ length: 10 }, (_, i) => `
								<div class="page" id="page${i}" style="background: hsl(${i * 36}, 70%, 40%)">
									Page ${i}
								</div>
							`).join('')}
						</div>
						<div class="spacer-bottom"></div>
					</div>
				</div>
			</div>
			<div id="debug" style="position:fixed;bottom:0;left:0;color:white;font-size:11px;z-index:9999;background:rgba(0,0,0,0.8);padding:4px;max-width:100%;white-space:pre-wrap;"></div>
		`);
	});

	/**
	 * Scroll to a specific page, then zoom at a given screen position.
	 * Returns the actual vs expected screen position of the content point.
	 */
	async function zoomAtPage(
		page: any,
		pageIndex: number,
		fromScreenX: number,
		fromScreenY: number,
		toScreenX: number,
		toScreenY: number,
		zoom: number
	) {
		return await page.evaluate(
			({ pageIndex, fromScreenX, fromScreenY, toScreenX, toScreenY, zoom }) => {
				const scroll = document.getElementById('scroll')!;
				const wrapper = document.getElementById('wrapper')!;
				const spacer = document.getElementById('spacer')!;
				const targetPage = document.getElementById(`page${pageIndex}`)!;
				const vh = window.innerHeight;
				const vw = window.innerWidth;

				// First, scroll to the target page (center it vertically)
				targetPage.scrollIntoView({ block: 'center' });

				// Read wrapper rect AFTER scroll
				const wrapperRect = wrapper.getBoundingClientRect();
				const currentZoom = 1;

				// Convert screen position to content space
				const contentX = (fromScreenX - wrapperRect.left) / currentZoom;
				const contentY = (fromScreenY - wrapperRect.top) / currentZoom;

				// Set spacer dimensions
				spacer.style.width = `${wrapper.offsetWidth * zoom}px`;
				spacer.style.minHeight = `${wrapper.offsetHeight * zoom + vh}px`;

				// Apply transform
				wrapper.style.transform = `scale(${zoom})`;

				// Force layout
				void scroll.scrollWidth;

				// Compute scroll position
				const WRAPPER_OFFSET_X = 0;
				const WRAPPER_OFFSET_Y = vh / 2;
				const computedScrollLeft = WRAPPER_OFFSET_X + contentX * zoom - toScreenX;
				const computedScrollTop = WRAPPER_OFFSET_Y + contentY * zoom - toScreenY;

				scroll.scrollLeft = computedScrollLeft;
				scroll.scrollTop = computedScrollTop;

				// Verify: where did the content point actually end up?
				const newWrapperRect = wrapper.getBoundingClientRect();
				const actualScreenX = newWrapperRect.left + contentX * zoom;
				const actualScreenY = newWrapperRect.top + contentY * zoom;

				// Also check what the page element looks like
				const pageRect = targetPage.getBoundingClientRect();

				const debug = document.getElementById('debug')!;
				debug.textContent = [
					`Page ${pageIndex} zoom=${zoom}`,
					`content=(${contentX.toFixed(0)}, ${contentY.toFixed(0)})`,
					`target=(${toScreenX}, ${toScreenY})`,
					`actual=(${actualScreenX.toFixed(0)}, ${actualScreenY.toFixed(0)})`,
					`scroll: computed=(${computedScrollLeft.toFixed(0)}, ${computedScrollTop.toFixed(0)}) actual=(${scroll.scrollLeft}, ${scroll.scrollTop})`,
					`scrollW=${scroll.scrollWidth} scrollH=${scroll.scrollHeight}`,
					`wrapperRect=(${newWrapperRect.left.toFixed(0)}, ${newWrapperRect.top.toFixed(0)})`,
					`pageRect=(${pageRect.left.toFixed(0)}, ${pageRect.top.toFixed(0)}, ${pageRect.width.toFixed(0)}x${pageRect.height.toFixed(0)})`,
					`scrollClamped: L=${computedScrollLeft !== scroll.scrollLeft} T=${computedScrollTop !== scroll.scrollTop}`
				].join('\n');

				return {
					pageIndex,
					contentX,
					contentY,
					computedScrollLeft,
					computedScrollTop,
					actualScrollLeft: scroll.scrollLeft,
					actualScrollTop: scroll.scrollTop,
					actualScreenX,
					actualScreenY,
					targetScreenX: toScreenX,
					targetScreenY: toScreenY,
					scrollWidth: scroll.scrollWidth,
					scrollHeight: scroll.scrollHeight,
					errorX: Math.abs(actualScreenX - toScreenX),
					errorY: Math.abs(actualScreenY - toScreenY),
					scrollClampedLeft: computedScrollLeft !== scroll.scrollLeft,
					scrollClampedTop: computedScrollTop !== scroll.scrollTop
				};
			},
			{ pageIndex, fromScreenX, fromScreenY, toScreenX, toScreenY, zoom }
		);
	}

	// Test zoom at page 0 (first page — known to work)
	test('page 0: double-tap center zooms correctly', async ({ page }) => {
		const vp = page.viewportSize()!;
		const r = await zoomAtPage(page, 0, vp.width / 2, vp.height / 2, vp.width / 2, vp.height / 2, 2);
		console.log(`Page 0 center: error=(${r.errorX.toFixed(1)}, ${r.errorY.toFixed(1)}) clamped=(${r.scrollClampedLeft}, ${r.scrollClampedTop})`);
		expect(r.errorX).toBeLessThan(2);
		expect(r.errorY).toBeLessThan(2);
	});

	// Test zoom at page 4 (middle of volume — likely to fail)
	test('page 4: double-tap center zooms correctly', async ({ page }) => {
		const vp = page.viewportSize()!;
		const r = await zoomAtPage(page, 4, vp.width / 2, vp.height / 2, vp.width / 2, vp.height / 2, 2);
		console.log(`Page 4 center: error=(${r.errorX.toFixed(1)}, ${r.errorY.toFixed(1)}) clamped=(${r.scrollClampedLeft}, ${r.scrollClampedTop})`);
		expect(r.errorX).toBeLessThan(2);
		expect(r.errorY).toBeLessThan(2);
	});

	// Test zoom at page 9 (last page)
	test('page 9: double-tap center zooms correctly', async ({ page }) => {
		const vp = page.viewportSize()!;
		const r = await zoomAtPage(page, 9, vp.width / 2, vp.height / 2, vp.width / 2, vp.height / 2, 2);
		console.log(`Page 9 center: error=(${r.errorX.toFixed(1)}, ${r.errorY.toFixed(1)}) clamped=(${r.scrollClampedLeft}, ${r.scrollClampedTop})`);
		expect(r.errorX).toBeLessThan(2);
		expect(r.errorY).toBeLessThan(2);
	});

	// Test zoom at page 4 — click on RIGHT side, target CENTER
	test('page 4: right-side click zooms to center', async ({ page }) => {
		const vp = page.viewportSize()!;
		const r = await zoomAtPage(page, 4, vp.width / 2 + 150, vp.height / 2, vp.width / 2, vp.height / 2, 2);
		console.log(`Page 4 right: error=(${r.errorX.toFixed(1)}, ${r.errorY.toFixed(1)}) clamped=(${r.scrollClampedLeft}, ${r.scrollClampedTop})`);
		expect(r.errorX).toBeLessThan(2);
		expect(r.errorY).toBeLessThan(2);
	});

	// Test zoom at page 4 — click on LEFT side, target CENTER
	test('page 4: left-side click zooms to center', async ({ page }) => {
		const vp = page.viewportSize()!;
		const r = await zoomAtPage(page, 4, vp.width / 2 - 150, vp.height / 2, vp.width / 2, vp.height / 2, 2);
		console.log(`Page 4 left: error=(${r.errorX.toFixed(1)}, ${r.errorY.toFixed(1)}) clamped=(${r.scrollClampedLeft}, ${r.scrollClampedTop})`);
		// Left side might get clamped if scrollLeft would be negative
		if (!r.scrollClampedLeft) {
			expect(r.errorX).toBeLessThan(2);
		}
		expect(r.errorY).toBeLessThan(2);
	});

	// Test zoom at page 7 with zoom level 3
	test('page 7: zoom 3x center', async ({ page }) => {
		const vp = page.viewportSize()!;
		const r = await zoomAtPage(page, 7, vp.width / 2, vp.height / 2, vp.width / 2, vp.height / 2, 3);
		console.log(`Page 7 z3: error=(${r.errorX.toFixed(1)}, ${r.errorY.toFixed(1)}) clamped=(${r.scrollClampedLeft}, ${r.scrollClampedTop})`);
		expect(r.errorX).toBeLessThan(2);
		expect(r.errorY).toBeLessThan(2);
	});
});
