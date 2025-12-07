<script lang="ts">
  import { run } from 'svelte/legacy';
  import type { TransitionConfig } from 'svelte/transition';

  import { currentSeries, currentVolume, currentVolumeData } from '$lib/catalog';
  import {
    Panzoom,
    panzoomStore,
    scrollImage,
    toggleFullScreen,
    zoomDefault,
    zoomDefaultWithLayoutWait,
    zoomFitToScreen
  } from '$lib/panzoom';
  import {
    effectiveVolumeSettings,
    invertColorsActive,
    progress,
    settings,
    updateProgress,
    updateSetting,
    updateVolumeSetting,
    volumes,
    type VolumeSettings
  } from '$lib/settings';
  import { clamp, debounce, fireExstaticEvent, resetScrollPosition } from '$lib/util';
  import { Input, Popover, Range, Spinner } from 'flowbite-svelte';
  import MangaPage from './MangaPage.svelte';
  import {
    BackwardStepSolid,
    CaretLeftSolid,
    CaretRightSolid,
    ForwardStepSolid
  } from 'flowbite-svelte-icons';
  import Cropper from './Cropper.svelte';
  import SettingsButton from './SettingsButton.svelte';
  import { getCharCount } from '$lib/util/count-chars';
  import QuickActions from './QuickActions.svelte';
  import { nav, navigateBack } from '$lib/util/hash-router';
  import { onMount, onDestroy, tick } from 'svelte';
  import { activityTracker } from '$lib/util/activity-tracker';
  import { shouldShowSinglePage } from '$lib/reader/page-mode-detection';
  import { ImageCache } from '$lib/reader/image-cache';
  import '$lib/styles/page-transitions.css';

  // TODO: Refactor this whole mess
  interface Props {
    volumeSettings: VolumeSettings;
  }

  let { volumeSettings: _volumeSettingsProp }: Props = $props();

  let volume = $derived($currentVolume);
  let volumeData = $derived($currentVolumeData);

  // Use store directly for reactivity instead of prop
  let volumeSettings = $derived(
    $effectiveVolumeSettings[volume?.volume_uuid || ''] || _volumeSettingsProp
  );

  let start: Date;

  function mouseDown() {
    start = new Date();
  }

  export function toggleHasCover(volumeId: string) {
    updateVolumeSetting(volumeId, 'hasCover', !volumeSettings.hasCover);
    const pageClamped = Math.max($volumes[volumeId].progress - 1, 1);
    updateProgress(volumeId, pageClamped);
    zoomDefault();
  }

  function left(_e: any, ingoreTimeOut?: boolean) {
    if (volumeSettings.rightToLeft) {
      // RTL: left is forward
      const newPage = page + navAmount;
      changePage(newPage, ingoreTimeOut);
    } else {
      // LTR: left is backward - check target page mode
      const newPage = calculateBackwardTarget(page);
      changePage(newPage, ingoreTimeOut);
    }
  }

  function right(_e: any, ingoreTimeOut?: boolean) {
    if (volumeSettings.rightToLeft) {
      // RTL: right is backward - check target page mode
      const newPage = calculateBackwardTarget(page);
      changePage(newPage, ingoreTimeOut);
    } else {
      // LTR: right is forward
      const newPage = page + navAmount;
      changePage(newPage, ingoreTimeOut);
    }
  }

  // Calculate target page when navigating backward, accounting for single-page exceptions
  function calculateBackwardTarget(currentPage: number): number {
    const targetIndex = currentPage - 2; // Try going back by current navAmount (assuming dual)

    if (targetIndex < 0) {
      return currentPage - 1; // Just go back 1 if we're near the start
    }

    const targetPage = pages?.[targetIndex];
    const targetNextPage = pages?.[targetIndex + 1];
    const targetPreviousPage = targetIndex > 0 ? pages?.[targetIndex - 1] : undefined;

    // Check if the target page should be shown in single mode
    const targetShouldBeSingle = shouldShowSinglePage(
      volumeSettings.singlePageView ?? 'auto',
      targetPage,
      targetNextPage,
      targetPreviousPage,
      targetIndex === 0,
      volumeSettings.hasCover
    );

    if (targetShouldBeSingle) {
      // Target is a single-page exception, only go back by 1
      return currentPage - 1;
    } else {
      // Target is dual-page, go back by current navAmount
      return currentPage - navAmount;
    }
  }

  function changePage(newPage: number, ingoreTimeOut = false) {
    const end = new Date();
    const clickDuration = ingoreTimeOut ? 0 : end.getTime() - start?.getTime();

    // Only apply click duration check for mouse/touch events, not for manual input
    if (pages && volume && (ingoreTimeOut || clickDuration < 200)) {
      if (showSecondPage() && page >= pages.length && newPage > page) {
        return;
      }

      // Clamp to valid page range first
      const pageClamped = clamp(newPage, 1, pages?.length);

      // Only navigate to another volume if we're already at the edge
      // AND trying to go further in that direction
      if (newPage < 1 && page === 1) {
        // Already on first page, trying to go back - navigate to previous volume
        let seriesVolumes = $currentSeries;
        const currentVolumeIndex = seriesVolumes.findIndex(
          (v) => v.volume_uuid === volume.volume_uuid
        );
        const previousVolume = seriesVolumes[currentVolumeIndex - 1];
        if (previousVolume) nav.toReader(volume.series_uuid, previousVolume.volume_uuid);
        else nav.toSeries(volume.series_uuid);
        return;
      } else if (newPage > pages.length && page === pages.length) {
        // Already on last page, trying to go forward - navigate to next volume
        let seriesVolumes = $currentSeries;
        const currentVolumeIndex = seriesVolumes.findIndex(
          (v) => v.volume_uuid === volume.volume_uuid
        );
        const nextVolume = seriesVolumes[currentVolumeIndex + 1];
        if (nextVolume) nav.toReader(volume.series_uuid, nextVolume.volume_uuid);
        else nav.toSeries(volume.series_uuid);
        return;
      }

      // Valid page within this volume - navigate to it
      // Set page direction BEFORE the page changes (for animations)
      pageDirection = pageClamped > page ? 'forward' : 'backward';

      const { charCount } = getCharCount(pages, pageClamped);
      updateProgress(
        volume.volume_uuid,
        pageClamped,
        charCount,
        pageClamped === pages.length || pageClamped === pages.length - 1
      );

      // Record activity for auto-timer and auto-sync
      activityTracker.recordActivity();
    }
  }

  function onInputClick(this: any) {
    this.select();
  }

  function onManualPageChange() {
    if (manualPage !== undefined && manualPage !== null) {
      const newPage = parseInt(manualPage.toString(), 10);
      if (!isNaN(newPage)) {
        changePage(newPage, true);
      }
    }
  }

  function handleShortcuts(event: KeyboardEvent & { currentTarget: EventTarget & Window }) {
    // Ignore shortcuts when user is in a text input, editable field, text box, or UI overlay
    const target = event.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable ||
      target.closest('#settings') || // Settings drawer
      target.closest('[data-popover]') || // Page number popover and other popovers
      target.closest('.textBox') // OCR text boxes (even when not editable)
    ) {
      return;
    }

    const action = event.code || event.key;

    // For letter keys and nav keys, ignore if any modifier key is pressed
    // (e.g., Ctrl+C for copy, Shift+Arrow for text selection)
    const isLetterKey = action.startsWith('Key');
    const isNavKey = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(
      action
    );
    if (
      (isLetterKey || isNavKey) &&
      (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey)
    ) {
      return;
    }

    // Keys that should prevent default browser scrolling behavior
    const scrollKeys = [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'PageUp',
      'PageDown',
      'Home',
      'End',
      'Space'
    ];

    if (scrollKeys.includes(action)) {
      event.preventDefault();
    }

    switch (action) {
      case 'ArrowLeft':
        left(event, true);
        return;
      case 'ArrowUp':
        scrollImage('up');
        return;
      case 'PageUp':
        changePage(page - navAmount, true);
        return;
      case 'ArrowRight':
        right(event, true);
        return;
      case 'ArrowDown':
        scrollImage('down');
        return;
      case 'PageDown':
      case 'Space':
        changePage(page + navAmount, true);
        return;
      case 'Home':
        changePage(1, true);
        return;
      case 'End':
        if (pages) {
          changePage(pages.length, true);
        }
        return;
      case 'KeyF':
        toggleFullScreen();
        return;
      case 'KeyI':
        if ($settings.invertColorsSchedule.enabled) {
          showNotification('Invert is on automatic schedule', 'invert-scheduled');
        } else {
          updateSetting('invertColors', !$settings.invertColors);
          showNotification($settings.invertColors ? 'Invert Off' : 'Invert On', 'invert-toggle');
        }
        return;
      case 'KeyN':
        if ($settings.nightModeSchedule.enabled) {
          showNotification('Night mode is on automatic schedule', 'nightmode-scheduled');
        } else {
          updateSetting('nightMode', !$settings.nightMode);
          showNotification(
            $settings.nightMode ? 'Night Mode Off' : 'Night Mode On',
            'nightmode-toggle'
          );
        }
        return;
      case 'KeyC':
        if (volume) {
          toggleHasCover(volume.volume_uuid);
        }
        return;
      case 'KeyP':
        rotatePageMode();
        return;
      case 'KeyZ':
        rotateZoomMode();
        return;
      case 'Escape':
        navigateBack();
        return;
      default:
        break;
    }
  }

  let startX = 0;
  let startY = 0;
  let touchStart: Date;

  function handleTouchStart(event: TouchEvent) {
    if ($settings.mobile) {
      const { clientX, clientY } = event.touches[0];
      touchStart = new Date();

      startX = clientX;
      startY = clientY;
    }
  }

  function handlePointerUp(event: TouchEvent) {
    if ($settings.mobile) {
      debounce(() => {
        if (event.touches.length === 0) {
          const { clientX, clientY } = event.changedTouches[0];

          const distanceX = clientX - startX;
          const distanceY = clientY - startY;

          const isSwipe = distanceY < 200 && distanceY > 200 * -1;

          const end = new Date();
          const touchDuration = end.getTime() - touchStart?.getTime();

          if (isSwipe && touchDuration < 500) {
            const swipeThreshold = Math.abs(($settings.swipeThreshold / 100) * window.innerWidth);

            if (distanceX > swipeThreshold) {
              left(event, true);
            } else if (distanceX < swipeThreshold * -1) {
              right(event, true);
            }
          }
        }
      });
    }
  }

  function onDoubleTap(event: MouseEvent) {
    if ($panzoomStore) {
      const { clientX, clientY } = event;
      const { scale } = $panzoomStore.getTransform();

      if (scale < 1) {
        $panzoomStore.zoomTo(clientX, clientY, 1.5);
      } else {
        zoomFitToScreen();
      }
    }
  }

  onMount(() => {
    // Set the timeout duration from settings
    activityTracker.setTimeoutDuration($settings.inactivityTimeoutMinutes);

    // Enter fullscreen on initial load if defaultFullscreen setting is enabled
    if ($settings.defaultFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.error('Failed to enter fullscreen:', err);
      });
    }

    // Prevent scrollbars from appearing when in reader mode
    document.documentElement.style.overflow = 'hidden';

    return () => {
      // Stop activity tracker when component unmounts
      activityTracker.stop();
      // Restore overflow when leaving reader
      document.documentElement.style.overflow = '';
    };
  });

  // Update timeout duration when settings change
  $effect(() => {
    activityTracker.setTimeoutDuration($settings.inactivityTimeoutMinutes);
  });

  // Apply zoom after page changes or settings changes
  // This ensures proper scaling and centering when page dimensions or layout settings change
  $effect(() => {
    const pg = page;
    const pgs = pages;
    const pz = $panzoomStore;

    // Add dependencies on settings that affect layout and zoom
    const zoomMode = $settings.zoomDefault;
    const pageMode = volumeSettings.singlePageView;
    const hasCover = volumeSettings.hasCover;
    const rtl = volumeSettings.rightToLeft;

    // Wait for all required data and panzoom instance to be ready
    if (pg && pgs && pgs.length > 0 && pz) {
      // Wait for Svelte DOM updates, then wait for browser layout reflow
      // This is critical for auto page mode switching to have correct dimensions
      tick().then(() => {
        zoomDefaultWithLayoutWait();
      });
    }
  });

  // Fire reader closed event when component is destroyed (navigating away)
  onDestroy(() => {
    if (volume) {
      const { charCount, lineCount } = getCharCount(pages, page);

      fireExstaticEvent('mokuro-reader:reader.closed', {
        title: volume.series_title,
        volumeName: volume.volume_title,
        currentCharCount: charCount,
        currentPage: page,
        totalPages: pages.length,
        totalCharCount: maxCharCount || 0,
        currentLineCount: lineCount,
        totalLineCount
      });
    }
  });

  let pages = $derived(volumeData?.pages || []);
  let page = $derived($progress?.[volume?.volume_uuid || 0] || 1);
  let index = $derived(page - 1);

  // Track page direction for animations (set in changePage function before page changes)
  let pageDirection = $state<'forward' | 'backward'>('forward');

  // Custom page intro (new page coming in)
  function pageIn(
    node: HTMLElement,
    { direction }: { direction: 'forward' | 'backward' }
  ): TransitionConfig {
    const transition = $settings.pageTransition;
    const isRTL = volumeSettings.rightToLeft;
    const visualDirection = (direction === 'forward') !== isRTL ? 'right' : 'left';

    const durations = {
      crossfade: 200,
      vertical: 400,
      pageTurn: 200,
      swipe: 350,
      none: 0
    };

    const duration = durations[transition] || 0;

    if (transition === 'none') {
      return { duration: 0 };
    }

    return {
      duration,
      easing: (t) => t, // Linear easing for consistent speed
      css: (t) => {
        if (transition === 'crossfade') {
          return `opacity: ${t}`;
        }

        if (transition === 'vertical') {
          // Slide vertically with a small gap between pages
          const gap = 3; // Small gap between pages (in vh units)
          const startOffset = direction === 'forward' ? 100 + gap : -(100 + gap);
          const currentPos = startOffset * (1 - t);
          return `
            transform: translateY(${currentPos}vh);
          `;
        }

        if (transition === 'pageTurn') {
          // New page wipes in on top of old page
          // Wipe direction depends on reading direction and forward/backward
          const clipPercent =
            visualDirection === 'right'
              ? 100 * (1 - t) // Right to left wipe
              : 100 * t; // Left to right wipe

          const clipPath =
            visualDirection === 'right'
              ? `polygon(${clipPercent}% 0, 100% 0, 100% 100%, ${clipPercent}% 100%)` // Right to left
              : `polygon(0 0, ${clipPercent}% 0, ${clipPercent}% 100%, 0 100%)`; // Left to right

          return `clip-path: ${clipPath};`;
        }

        if (transition === 'swipe') {
          // New page swipes in from the direction
          const fromPos = visualDirection === 'left' ? -100 : 100;
          const currentPos = fromPos * (1 - t);
          const scale = 0.8 + t * 0.2;
          return `
            transform: translateX(${currentPos}%) scale(${scale});
            opacity: ${t};
          `;
        }

        return '';
      }
    };
  }

  // Custom page outro (old page going out)
  function pageOut(
    node: HTMLElement,
    { direction }: { direction: 'forward' | 'backward' }
  ): TransitionConfig {
    const transition = $settings.pageTransition;
    const isRTL = volumeSettings.rightToLeft;
    const visualDirection = (direction === 'forward') !== isRTL ? 'right' : 'left';

    const durations = {
      crossfade: 200,
      vertical: 400,
      pageTurn: 200,
      swipe: 350,
      none: 0
    };

    const duration = durations[transition] || 0;

    if (transition === 'none') {
      return { duration: 0 };
    }

    return {
      duration,
      easing: (t) => t, // Linear easing for consistent speed
      css: (t) => {
        if (transition === 'crossfade') {
          return `opacity: ${t}`;
        }

        if (transition === 'vertical') {
          // Slide vertically - now used for ENTERING page
          const gap = 3; // Small gap between pages (in vh units)
          const endOffset = direction === 'forward' ? -(100 + gap) : 100 + gap;
          const currentPos = endOffset * (1 - t);
          return `
            transform: translateY(${currentPos}vh);
          `;
        }

        if (transition === 'pageTurn') {
          // Old page stays visible underneath new page
          return `opacity: 1`;
        }

        if (transition === 'swipe') {
          // Old page swipes out to the OPPOSITE direction
          const toPos = visualDirection === 'left' ? 30 : -30;
          const currentPos = toPos * (1 - t);
          const scale = 1 - (1 - t) * 0.1;
          return `
            transform: translateX(${currentPos}%) scale(${scale});
            opacity: ${t};
          `;
        }

        return '';
      }
    };
  }

  // Image cache for preloading
  let imageCache = new ImageCache();
  let cachedImageUrl1 = $state<string | null>(null);
  let cachedImageUrl2 = $state<string | null>(null);

  // Update cache when page or volume data changes
  $effect(() => {
    const currentIndex = index;
    const files = volumeData?.files;
    const pgs = pages;

    if (files && pgs.length > 0 && currentIndex >= 0) {
      // Update cache first (non-blocking - preloads in background)
      imageCache.updateCache(files, pgs, currentIndex);

      // Try to get current page image synchronously (instant if already cached)
      const syncUrl1 = imageCache.getImageSync(currentIndex);
      if (syncUrl1) {
        cachedImageUrl1 = syncUrl1;
      } else {
        // Not ready yet, get it async and update when ready
        cachedImageUrl1 = null;
        imageCache.getImage(currentIndex).then((url) => {
          cachedImageUrl1 = url;
        });
      }

      // Try to get next page image if showing second page
      if (showSecondPage()) {
        const syncUrl2 = imageCache.getImageSync(currentIndex + 1);
        if (syncUrl2) {
          cachedImageUrl2 = syncUrl2;
        } else {
          cachedImageUrl2 = null;
          imageCache.getImage(currentIndex + 1).then((url) => {
            cachedImageUrl2 = url;
          });
        }
      } else {
        cachedImageUrl2 = null;
      }
    } else {
      cachedImageUrl1 = null;
      cachedImageUrl2 = null;
    }
  });

  onDestroy(() => {
    imageCache.cleanup();
  });

  // Window size state for reactive auto-detection
  let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 0);
  let windowHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 0);

  // Determine if we should show single page based on mode, pages, and screen
  // Force calculation to wait for all data by using a single derived with explicit dependencies
  let useSinglePage = $derived.by(() => {
    // Explicit dependency on all required reactive values
    // This ensures we don't calculate until everything is loaded
    const vol = volume;
    const pgs = pages;
    const idx = index;
    const prog = $progress;

    // Wait for all data to exist
    if (!vol || !pgs || pgs.length === 0 || !prog || prog[vol.volume_uuid] === undefined) {
      return true; // Safe default while loading
    }

    const currentPage = pgs[idx];
    const nextPage = pgs[idx + 1];
    const previousPage = idx > 0 ? pgs[idx - 1] : undefined;

    // Reference window dimensions to create reactive dependency
    // This ensures the detection re-runs when window size changes
    const _width = windowWidth;
    const _height = windowHeight;

    // Use auto-detection function with width consistency checking
    return shouldShowSinglePage(
      volumeSettings.singlePageView ?? 'auto',
      currentPage,
      nextPage,
      previousPage,
      idx === 0, // isFirstPage
      volumeSettings.hasCover
    );
  });

  let navAmount = $derived(
    useSinglePage || (volumeSettings.hasCover && !useSinglePage && index === 0) ? 1 : 2
  );

  let showSecondPage = $derived(() => {
    if (!pages) {
      return false;
    }

    if (useSinglePage || index + 1 >= pages.length) {
      return false;
    }

    if (index === 0 && volumeSettings.hasCover) {
      return false;
    }

    return true;
  });
  let manualPage = $state(0);
  run(() => {
    manualPage = page;
  });
  let pageDisplay = $derived(
    showSecondPage() ? `${page},${page + 1} / ${pages?.length}` : `${page} / ${pages?.length}`
  );
  let charCount = $derived($settings.charCount ? getCharCount(pages, page).charCount : 0);
  let maxCharCount = $derived(getCharCount(pages).charCount);
  let charDisplay = $derived(`${charCount} / ${maxCharCount}`);
  let totalLineCount = $derived(getCharCount(pages).lineCount);
  run(() => {
    if (volume) {
      const { charCount, lineCount } = getCharCount(pages, page);

      fireExstaticEvent('mokuro-reader:page.change', {
        title: volume.series_title,
        volumeName: volume.volume_title,
        currentCharCount: charCount,
        currentPage: page,
        totalPages: pages.length,
        totalCharCount: maxCharCount || 0,
        currentLineCount: lineCount,
        totalLineCount
      });
    }
  });

  // Generic notification system for setting changes
  let notificationMessage = $state<string>('');
  let notificationKey = $state<string>('');
  let notificationTimeout: number | undefined = undefined;

  function showNotification(message: string, key: string) {
    notificationMessage = message;
    notificationKey = key;

    // Clear existing timeout
    if (notificationTimeout !== undefined) {
      clearTimeout(notificationTimeout);
    }

    // Hide notification after 2 seconds
    notificationTimeout = window.setTimeout(() => {
      notificationMessage = '';
      notificationKey = '';
    }, 2000);
  }

  function rotatePageMode() {
    if (!volume) return;

    const currentMode = volumeSettings.singlePageView ?? 'auto';
    let nextMode: 'single' | 'dual' | 'auto';

    // Rotate through: single -> dual -> auto -> single
    if (currentMode === 'single') {
      nextMode = 'dual';
    } else if (currentMode === 'dual') {
      nextMode = 'auto';
    } else {
      nextMode = 'single';
    }

    updateVolumeSetting(volume.volume_uuid, 'singlePageView', nextMode);

    // Show notification with the new mode
    const labels = { single: 'Single Page', dual: 'Dual Page', auto: 'Auto Page' };
    showNotification(labels[nextMode], `pagemode-${nextMode}`);
  }

  function rotateZoomMode() {
    const currentMode = $settings.zoomDefault;
    let nextMode: typeof currentMode;

    // Rotate through: fitToScreen -> fitToWidth -> original -> keepZoom -> keepZoomStart -> fitToScreen
    if (currentMode === 'zoomFitToScreen') {
      nextMode = 'zoomFitToWidth';
    } else if (currentMode === 'zoomFitToWidth') {
      nextMode = 'zoomOriginal';
    } else if (currentMode === 'zoomOriginal') {
      nextMode = 'keepZoom';
    } else if (currentMode === 'keepZoom') {
      nextMode = 'keepZoomStart';
    } else {
      nextMode = 'zoomFitToScreen';
    }

    updateSetting('zoomDefault', nextMode);

    // Show notification with the new mode
    const labels = {
      zoomFitToScreen: 'Fit to Screen',
      zoomFitToWidth: 'Fit to Width',
      zoomOriginal: 'Original Size',
      keepZoom: 'Keep Zoom',
      keepZoomStart: 'Keep Zoom, Pan to Top'
    };
    showNotification(labels[nextMode], `zoommode-${nextMode}`);
  }
</script>

<svelte:window
  onresize={() => {
    windowWidth = window.innerWidth;
    windowHeight = window.innerHeight;
    zoomDefaultWithLayoutWait();
  }}
  onkeydown={handleShortcuts}
  ontouchstart={handleTouchStart}
  ontouchend={handlePointerUp}
  onscroll={() => {
    // Detect and fix scroll position drift caused by scrolling in overlays
    // (e.g., settings menu) that affects the underlying document
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      resetScrollPosition();
    }
  }}
/>
<svelte:head>
  <title>{volume?.volume_title || 'Volume'}</title>
</svelte:head>
{#if volume && pages && pages.length > 0 && volumeData && $progress?.[volume.volume_uuid] !== undefined}
  <QuickActions
    {left}
    {right}
    src1={imageCache.getFile(index)}
    src2={!useSinglePage ? imageCache.getFile(index + 1) : undefined}
  />
  <SettingsButton />
  <Cropper />
  <Popover placement="bottom" trigger="click" triggeredBy="#page-num" class="z-20 w-full max-w-xs">
    <div class="flex flex-col gap-3">
      <div class="z-10 flex flex-row items-center gap-5">
        <button onclick={() => changePage(volumeSettings.rightToLeft ? pages.length : 1, true)}>
          <BackwardStepSolid class="hover:text-primary-600" size="sm" />
        </button>
        <button onclick={(e) => left(e, true)}>
          <CaretLeftSolid class="hover:text-primary-600" size="sm" />
        </button>
        <Input
          type="number"
          size="sm"
          bind:value={manualPage}
          onclick={onInputClick}
          onchange={onManualPageChange}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              onManualPageChange();
              if (e.currentTarget && 'blur' in e.currentTarget) {
                (e.currentTarget as HTMLElement).blur();
              }
            }
          }}
          onblur={onManualPageChange}
        />
        <button onclick={(e) => right(e, true)}>
          <CaretRightSolid class="hover:text-primary-600" size="sm" />
        </button>
        <button onclick={() => changePage(volumeSettings.rightToLeft ? 1 : pages.length, true)}>
          <ForwardStepSolid class="hover:text-primary-600" size="sm" />
        </button>
      </div>
      <div style:direction={volumeSettings.rightToLeft ? 'rtl' : 'ltr'}>
        <Range min={1} max={pages.length} bind:value={manualPage} onchange={onManualPageChange} />
      </div>
    </div>
  </Popover>
  <button class="fixed top-5 left-5 z-10 opacity-50 mix-blend-difference" id="page-num">
    {#key page}
      <p class="text-left" class:hidden={!$settings.charCount}>{charDisplay}</p>
      <p class="text-left" class:hidden={!$settings.pageNum}>{pageDisplay}</p>
    {/key}
  </button>
  {#if notificationMessage}
    {#key notificationKey}
      <div
        class="fixed top-5 left-1/2 z-20 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2 text-white shadow-lg transition-opacity"
        style="backdrop-filter: blur(8px); background-color: rgba(17, 24, 39, 0.9);"
      >
        <p class="text-sm font-medium whitespace-nowrap">{notificationMessage}</p>
      </div>
    {/key}
  {/if}
  <div class="flex" style:background-color={$settings.backgroundColor}>
    <Panzoom>
      <button
        aria-label="Previous page (left edge)"
        class="fixed -left-full z-10 h-full w-full opacity-[0.01] hover:bg-slate-400"
        style:margin-left={`${$settings.edgeButtonWidth}px`}
        onmousedown={mouseDown}
        onmouseup={left}
      ></button>
      <button
        aria-label="Next page (right edge)"
        class="fixed -right-full z-10 h-full w-full opacity-[0.01] hover:bg-slate-400"
        style:margin-right={`${$settings.edgeButtonWidth}px`}
        onmousedown={mouseDown}
        onmouseup={right}
      ></button>
      <button
        aria-label="Previous page (bottom left)"
        class="fixed top-full -left-full z-10 h-screen w-[150%] opacity-[0.01] hover:bg-slate-400"
        onmousedown={mouseDown}
        onmouseup={left}
      ></button>
      <button
        aria-label="Next page (bottom right)"
        class="fixed top-full -right-full z-10 h-screen w-[150%] opacity-[0.01] hover:bg-slate-400"
        onmousedown={mouseDown}
        onmouseup={right}
      ></button>
      <div
        class="grid"
        style:filter={`invert(${$invertColorsActive ? 1 : 0})`}
        ondblclick={onDoubleTap}
        role="none"
        id="manga-panel"
      >
        {#key page}
          <div
            class="col-start-1 row-start-1 flex flex-row"
            class:flex-row-reverse={!volumeSettings.rightToLeft}
            in:pageIn={{ direction: pageDirection }}
            out:pageOut={{ direction: pageDirection }}
          >
            {#if volumeData?.files}
              {#if showSecondPage()}
                <MangaPage
                  page={pages[index + 1]}
                  src={imageCache.getFile(index + 1)!}
                  cachedUrl={cachedImageUrl2}
                  volumeUuid={volume.volume_uuid}
                />
              {/if}
              <MangaPage
                page={pages[index]}
                src={imageCache.getFile(index)!}
                cachedUrl={cachedImageUrl1}
                volumeUuid={volume.volume_uuid}
              />
            {:else}
              <div class="flex h-screen w-screen items-center justify-center">
                <Spinner size="12" />
              </div>
            {/if}
          </div>
        {/key}
      </div>
    </Panzoom>
  </div>
  {#if !$settings.mobile}
    <button
      aria-label="Previous page (left edge)"
      onmousedown={mouseDown}
      onmouseup={left}
      class="absolute top-0 left-0 h-full w-16 opacity-[0.01] hover:bg-slate-400"
      style:width={`${$settings.edgeButtonWidth}px`}
    ></button>
    <button
      aria-label="Next page (right edge)"
      onmousedown={mouseDown}
      onmouseup={right}
      class="absolute top-0 right-0 h-full w-16 opacity-[0.01] hover:bg-slate-400"
      style:width={`${$settings.edgeButtonWidth}px`}
    ></button>
  {/if}
{:else}
  <div class="fixed top-1/2 left-1/2 z-50">
    <Spinner />
  </div>
{/if}
