<script lang="ts">
  import { run } from 'svelte/legacy';
  import type { TransitionConfig } from 'svelte/transition';

  import { currentSeries, currentVolume, currentVolumeData } from '$lib/catalog';
  import PagedViewport from './PagedViewport.svelte';
  import { pagedZoom } from '$lib/reader/paged-zoom';
  import { setInstantAnimations } from '$lib/reader/animator';
  import { keyboardShouldIgnore } from '$lib/reader/input/gesture-target';
  import { toggleFullScreen } from '$lib/util/fullscreen';
  import {
    effectiveVolumeSettings,
    imageFilter,
    progress,
    settings,
    updateProgress,
    updateSetting,
    updateVolumeSetting,
    volumes,
    type VolumeSettings,
    type ContinuousZoomMode,
    type ScheduleSettingKey
  } from '$lib/settings';
  import { clamp, fireExstaticEvent, resetScrollPosition } from '$lib/util';
  import { Input, Popover, Range, Spinner } from 'flowbite-svelte';
  import MangaPage from './MangaPage.svelte';
  import TextBoxContextMenu from './TextBoxContextMenu.svelte';
  import {
    openCreateModal,
    openUpdateModal,
    sendQuickCapture,
    getLastCardInfo,
    getCardAgeInMin,
    extractFieldValues,
    getModelConfig,
    blobToBase64,
    type VolumeMetadata
  } from '$lib/anki-connect';
  import { db } from '$lib/catalog/db';
  import { showSnackbar } from '$lib/util';
  import {
    BackwardStepSolid,
    CaretLeftSolid,
    CaretRightSolid,
    ForwardStepSolid
  } from 'flowbite-svelte-icons';
  import TextBoxPicker from './TextBoxPicker.svelte';
  import SettingsButton from './SettingsButton.svelte';
  import { getCharCount } from '$lib/util/count-chars';
  import QuickActions from './QuickActions.svelte';
  import VerticalScrollReader from './VerticalScrollReader.svelte';
  import HorizontalScrollReader from './HorizontalScrollReader.svelte';
  import { nav, navigateBack } from '$lib/util/hash-router';
  import { onMount, onDestroy } from 'svelte';
  import { activityTracker } from '$lib/util/activity-tracker';
  import { shouldShowSinglePage } from '$lib/reader/page-mode-detection';
  import { calculateForwardTarget, calculateBackwardTarget } from '$lib/reader/page-nav';
  import { ImageCache } from '$lib/reader/image-cache';
  import '$lib/styles/page-transitions.css';

  // TODO: Refactor this whole mess
  interface Props {
    volumeSettings: VolumeSettings;
    overlaysVisible?: boolean;
  }

  let { volumeSettings: _volumeSettingsProp, overlaysVisible = $bindable(true) }: Props = $props();

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
    // The paged viewport re-applies its base when the displayed content
    // changes (hasCover flows into the content-size prop).
  }

  function left(_e: any, ingoreTimeOut?: boolean) {
    if (volumeSettings.rightToLeft) {
      // RTL: left is forward
      navigateForward(ingoreTimeOut);
    } else {
      // LTR: left is backward - check target page mode
      navigateBackward(ingoreTimeOut);
    }
  }

  function right(_e: any, ingoreTimeOut?: boolean) {
    if (volumeSettings.rightToLeft) {
      // RTL: right is backward - check target page mode
      navigateBackward(ingoreTimeOut);
    } else {
      // LTR: right is forward
      navigateForward(ingoreTimeOut);
    }
  }

  // Spread-alignment target math lives in $lib/reader/page-nav (pure, tested).
  function pageNavContext() {
    return {
      pages,
      mode: $settings.singlePageView,
      hasCover: volumeSettings.hasCover ?? false,
      fallbackStep: navAmount
    };
  }

  function navigateForward(ingoreTimeOut?: boolean): void {
    changePage(calculateForwardTarget(page, pageNavContext()), ingoreTimeOut);
  }

  function navigateBackward(ingoreTimeOut?: boolean): void {
    changePage(calculateBackwardTarget(page, pageNavContext()), ingoreTimeOut);
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
        let seriesVolumes = $currentSeries || [];
        const currentVolumeIndex = seriesVolumes.findIndex(
          (v) => v.volume_uuid === volume.volume_uuid
        );
        const previousVolume = seriesVolumes[currentVolumeIndex - 1];
        if (previousVolume) nav.toReader(volume.series_uuid, previousVolume.volume_uuid);
        else nav.toSeries(volume.series_uuid);
        return;
      } else if (newPage > pages.length && page === pages.length) {
        // Already on last page, trying to go forward - navigate to next volume
        let seriesVolumes = $currentSeries || [];
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
    // Ignore shortcuts when the user is typing or inside reader UI overlays
    if (keyboardShouldIgnore(event.target)) {
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

    // In continuous scroll mode, let ContinuousScrollReader handle navigation keys
    if ($settings.continuousScroll) {
      const continuousModeKeys = [
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'PageUp',
        'PageDown',
        'Space',
        'Home',
        'End'
      ];
      if (continuousModeKeys.includes(action)) {
        return;
      }
    }

    switch (action) {
      case 'ArrowLeft':
        left(event, true);
        return;
      case 'ArrowUp':
        $pagedZoom?.scrollImage('up');
        return;
      case 'PageUp':
        navigateBackward(true);
        return;
      case 'ArrowRight':
        right(event, true);
        return;
      case 'ArrowDown':
        $pagedZoom?.scrollImage('down');
        return;
      case 'PageDown':
      case 'Space':
        navigateForward(true);
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
        toggleScheduledFilter('invertColors', 'invertColorsSchedule', 'Invert', 'invert');
        return;
      case 'KeyN':
        toggleScheduledFilter('nightMode', 'nightModeSchedule', 'Night Mode', 'nightmode');
        return;
      case 'KeyG':
        toggleScheduledFilter('grayscale', 'grayscaleSchedule', 'B&W', 'grayscale');
        return;
      case 'KeyC':
        if (volume) {
          toggleHasCover(volume.volume_uuid);
        }
        return;
      case 'KeyP':
        if ($settings.continuousScroll) {
          rotateScrollMode();
        } else {
          rotatePageMode();
        }
        return;
      case 'KeyO':
        offsetSpreads();
        return;
      case 'KeyZ':
        rotateZoomMode();
        return;
      case 'KeyM':
        if ($settings.continuousScroll) {
          const newVal = !$settings.pageDividers;
          updateSetting('pageDividers', newVal);
          showNotification(newVal ? 'Dividers On' : 'Dividers Off', 'page-dividers');
        }
        return;
      case 'KeyT': {
        const next = !$settings.alwaysShowOCR;
        updateSetting('alwaysShowOCR', next);
        showNotification(
          next ? 'Always Show OCR: On' : 'Always Show OCR: Off',
          'always-show-ocr-toggle'
        );
        return;
      }
      case 'KeyV':
        toggleContinuousScroll();
        return;
      case 'Escape':
        navigateBack();
        return;
      default:
        break;
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

    // The settings panel's "Offset spreads" button signals through this
    // event (it has no access to reader internals). The old PixiJS reader
    // was the listener; since its removal the button had dispatched into
    // the void.
    const onOffsetSpreads = () => offsetSpreads();
    window.addEventListener('offset-spreads', onOffsetSpreads);

    return () => {
      // Stop activity tracker when component unmounts
      activityTracker.stop();
      // Restore overflow when leaving reader
      document.documentElement.style.overflow = '';
      window.removeEventListener('offset-spreads', onOffsetSpreads);
    };
  });

  // Update timeout duration when settings change
  $effect(() => {
    activityTracker.setTimeoutDuration($settings.inactivityTimeoutMinutes);
  });

  // The paged viewport re-applies its base whenever the displayed content,
  // zoom mode, viewport, or reading direction changes — driven by the
  // pagedContentSize prop computed from page data (no DOM measurement, no
  // layout waits).
  let pagedContentSize = $derived.by(() => {
    const pgs = pages;
    const idx = index;
    if (!pgs || pgs.length === 0 || !pgs[idx]) return { width: 0, height: 0 };
    const first = pgs[idx];
    if (showSecondPage() && pgs[idx + 1]) {
      const second = pgs[idx + 1];
      return {
        width: first.img_width + second.img_width,
        height: Math.max(first.img_height, second.img_height)
      };
    }
    return { width: first.img_width, height: first.img_height };
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

  // Set of missing page paths for checking if current page is a placeholder
  let missingPagePaths = $derived(new Set(volume?.missing_page_paths || []));

  // E-ink mode: all reader animations (zoom, smooth scroll, camera pan) run
  // through Animator — flip its global instant mode from the setting.
  $effect(() => {
    setInstantAnimations($settings.disableAnimations);
  });

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
      pageTurn: 200,
      swipe: 350,
      none: 0
    };

    // Legacy persisted values (e.g. the removed 'vertical') fall to 0.
    const duration = durations[transition] || 0;

    if (duration === 0 || $settings.disableAnimations) {
      return { duration: 0 };
    }

    return {
      duration,
      easing: (t) => t, // Linear easing for consistent speed
      css: (t) => {
        if (transition === 'crossfade') {
          return `opacity: ${t}`;
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
      pageTurn: 200,
      swipe: 350,
      none: 0
    };

    // Legacy persisted values (e.g. the removed 'vertical') fall to 0.
    const duration = durations[transition] || 0;

    if (duration === 0 || $settings.disableAnimations) {
      return { duration: 0 };
    }

    return {
      duration,
      easing: (t) => t, // Linear easing for consistent speed
      css: (t) => {
        if (transition === 'crossfade') {
          return `opacity: ${t}`;
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

  // Update cache when page or volume data changes. Continuous readers render
  // their own blob URLs, but QuickActions reads imageCache.getFile() for Anki
  // image actions in BOTH modes — the cache must stay warm here.
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

  let effectiveScrollMode = $derived(
    $settings.scrollMode === 'auto'
      ? windowWidth > windowHeight
        ? 'horizontal'
        : 'vertical'
      : $settings.scrollMode
  );

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
      $settings.singlePageView,
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
  let continuousVisibleCount = $state(1);
  let pageDisplay = $derived.by(() => {
    if ($settings.continuousScroll) {
      // Continuous mode: use actual visible count from the scroll reader.
      // Only the horizontal reader reports counts — ignore a stale value
      // after switching to vertical.
      if (
        effectiveScrollMode === 'horizontal' &&
        continuousVisibleCount > 1 &&
        page + 1 <= (pages?.length ?? 0)
      ) {
        return `${page},${page + 1} / ${pages?.length}`;
      }
      return `${page} / ${pages?.length}`;
    }
    // Paged mode: use spread detection
    return showSecondPage()
      ? `${page},${page + 1} / ${pages?.length}`
      : `${page} / ${pages?.length}`;
  });
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

  // Context menu state (rendered outside the zoom wrapper for correct positioning)
  interface ContextMenuData {
    x: number;
    y: number;
    lines: string[];
    imgElement: HTMLElement | null;
    textBox?: [number, number, number, number]; // [xmin, ymin, xmax, ymax] for initial crop
    imageUrl?: string; // Captured at right-click time for reliability
    pageIndex?: number; // Which page the context menu was opened on
  }
  let showContextMenu = $state(false);
  let contextMenuData = $state<ContextMenuData | null>(null);

  // Extract image URL from an element by traversing up to find background-image
  function extractImageUrlFromElement(element: HTMLElement | null): string | null {
    if (!element) return null;
    let current: HTMLElement | null = element;
    while (current) {
      const bgImage = getComputedStyle(current).backgroundImage;
      if (bgImage && bgImage !== 'none') {
        const match = bgImage.match(/url\(["']?(.+?)["']?\)/);
        if (match) return match[1];
      }
      current = current.parentElement;
    }
    return null;
  }

  function handleTextBoxContextMenu(data: ContextMenuData) {
    // Capture the image URL immediately while the DOM is in a known good state
    // This prevents issues when Yomitan or other extensions modify the DOM
    const imageUrl = extractImageUrlFromElement(data.imgElement) ?? undefined;
    // Prefer pageIndex from the data (set by TextBoxes), fall back to progress store
    const pageIndex =
      data.pageIndex ??
      ($volumes[volume!.volume_uuid]?.progress
        ? ($volumes[volume!.volume_uuid].progress || 1) - 1
        : index);

    contextMenuData = {
      ...data,
      imageUrl,
      pageIndex
    };
    showContextMenu = true;
  }

  async function handleContextMenuAddToAnki(selection: string) {
    if (!contextMenuData || !volume) return;

    const volumeMetadata: VolumeMetadata = {
      seriesTitle: volume.series_title,
      volumeTitle: volume.volume_title
    };

    // Load cover image for {cover} template support
    try {
      const dbVolume = await db.volumes.get(volume.volume_uuid);
      if (dbVolume?.thumbnail) {
        const coverImage = await blobToBase64(dbVolume.thumbnail);
        if (coverImage) {
          volumeMetadata.coverImage = coverImage;
        }
      }
    } catch {
      // Continue without cover image
    }

    // Use pre-captured image URL (captured at right-click time for reliability)
    const url = contextMenuData.imageUrl;

    if (!url) {
      showSnackbar('Error: Could not get page image');
      return;
    }

    const fullSentence = contextMenuData.lines.join(' ');
    const cardFront = selection || fullSentence;
    const ankiTags = $settings.ankiConnectSettings.tags || '';
    const textBox = contextMenuData.textBox;
    // Use captured page index for reliability (in case page changed between right-click and menu click)
    const pageIndex =
      contextMenuData.pageIndex ?? ($volumes[volume.volume_uuid]?.progress || 1) - 1;
    const pageNumber = pageIndex + 1;
    const currentPage = pages[pageIndex];
    const pageFilename = currentPage?.img_path;
    const cardMode = $settings.ankiConnectSettings.cardMode;

    if (cardMode === 'update') {
      // Update mode: fetch previous card values
      const lastCard = await getLastCardInfo();

      if (!lastCard || !lastCard.noteId) {
        showSnackbar('No recent card found to update');
        return;
      }

      const cardAge = getCardAgeInMin(lastCard.noteId);
      if (cardAge >= 5) {
        showSnackbar(`Last card is ${cardAge} minutes old (max 5 min)`);
        return;
      }

      const previousValues = extractFieldValues(lastCard);

      // Get the model config to check for quickCapture setting
      const modelConfig = getModelConfig(lastCard.modelName, 'update');
      const quickCapture = modelConfig?.quickCapture ?? false;

      if (quickCapture) {
        await sendQuickCapture(
          'update',
          url,
          cardFront,
          fullSentence,
          volumeMetadata,
          textBox,
          previousValues,
          lastCard.noteId,
          lastCard.tags,
          lastCard.modelName,
          pageFilename
        );
      } else {
        // Show modal (also shown if quickCapture but no config exists)
        openUpdateModal(
          url,
          previousValues,
          lastCard.noteId,
          lastCard.modelName,
          lastCard.tags, // existing tags from the card
          cardFront,
          fullSentence,
          ankiTags,
          volumeMetadata,
          undefined,
          textBox,
          pageNumber,
          pageFilename
        );
      }
    } else {
      // Create mode
      const { selectedModel } = $settings.ankiConnectSettings;
      const modelConfig = getModelConfig(selectedModel, 'create');
      const quickCapture = modelConfig?.quickCapture ?? false;

      if (quickCapture) {
        await sendQuickCapture(
          'create',
          url,
          cardFront,
          fullSentence,
          volumeMetadata,
          textBox,
          undefined, // previousValues (not used for create)
          undefined, // previousCardId (not used for create)
          undefined, // previousTags (not used for create)
          undefined, // modelName (not needed for create)
          pageFilename
        );
      } else {
        // Show modal (also shown if quickCapture but no config exists)
        openCreateModal(
          url,
          cardFront,
          fullSentence,
          ankiTags,
          volumeMetadata,
          undefined,
          textBox,
          pageNumber,
          pageFilename
        );
      }
    }
  }

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

  // Shared toggle for the Manual/Scheduled display filters (night, invert,
  // B&W). When the schedule owns the filter we only notify; otherwise flip
  // the manual boolean and announce the state we just wrote. (The old code
  // re-read $settings after updateSetting expecting a stale value — the read
  // is synchronous, so every toast announced the OPPOSITE state.)
  function toggleScheduledFilter(
    settingKey: 'nightMode' | 'invertColors' | 'grayscale',
    scheduleKey: ScheduleSettingKey,
    label: string,
    notifPrefix: string
  ) {
    if ($settings[scheduleKey].enabled) {
      showNotification(`${label} is on automatic schedule`, `${notifPrefix}-scheduled`);
    } else {
      const next = !$settings[settingKey];
      updateSetting(settingKey, next);
      showNotification(next ? `${label} On` : `${label} Off`, `${notifPrefix}-toggle`);
    }
  }

  function rotateScrollMode() {
    const current = $settings.scrollMode;
    const order = ['auto', 'vertical', 'horizontal'] as const;
    const curIdx = order.indexOf(current as any);
    const next = order[(curIdx + 1) % order.length];
    updateSetting('scrollMode', next);
    const labels = {
      auto: 'Match Orientation',
      vertical: 'Vertical Scroll',
      horizontal: 'Horizontal Scroll'
    };
    showNotification(labels[next], `scrollmode-${next}`);
  }

  function rotatePageMode() {
    if (!volume) return;

    const currentMode = $settings.singlePageView;
    let nextMode: 'single' | 'dual' | 'auto';

    // Rotate through: single -> dual -> auto -> single
    if (currentMode === 'single') {
      nextMode = 'dual';
    } else if (currentMode === 'dual') {
      nextMode = 'auto';
    } else {
      nextMode = 'single';
    }

    updateSetting('singlePageView', nextMode);

    // Show notification with the new mode
    const labels = { single: 'Single Page', dual: 'Dual Page', auto: 'Auto Page' };
    showNotification(labels[nextMode], `pagemode-${nextMode}`);
  }

  function offsetSpreads() {
    // Shift spread pairing by toggling hasCover — the paged viewport and the
    // horizontal scroll reader both derive their pairing from it.
    if (volume) toggleHasCover(volume.volume_uuid);
    showNotification('Spreads Offset', 'offset-spreads');
  }

  function toggleContinuousScroll() {
    const newValue = !$settings.continuousScroll;
    updateSetting('continuousScroll', newValue);
    showNotification(
      newValue ? 'Continuous Scroll On' : 'Continuous Scroll Off',
      'continuous-scroll-toggle'
    );
  }

  function rotateContinuousZoomMode() {
    const currentMode = $settings.continuousZoomDefault;
    let nextMode: ContinuousZoomMode;

    // Rotate through: fillScreen -> fitToScreen -> original -> fillScreen
    if (currentMode === 'zoomFillScreen') {
      nextMode = 'zoomFitToScreen';
    } else if (currentMode === 'zoomFitToScreen') {
      nextMode = 'zoomOriginal';
    } else {
      nextMode = 'zoomFillScreen';
    }

    updateSetting('continuousZoomDefault', nextMode);

    const labels: Record<ContinuousZoomMode, string> = {
      zoomFillScreen: 'Fill Screen',
      zoomFitToScreen: 'Fit to Screen',
      zoomOriginal: 'Original Size'
    };
    showNotification(labels[nextMode], `zoommode-${nextMode}`);
  }

  // Callback for ContinuousReader page changes
  function handleContinuousPageChange(newPage: number, charCount: number, isComplete: boolean) {
    if (!volume) return;
    updateProgress(volume.volume_uuid, newPage, charCount, isComplete);
    activityTracker.recordActivity();
  }

  // Callback for scroll reader completion — navigate back to series page
  function handleContinuousVolumeNav(_direction: 'prev' | 'next') {
    if (!volume) return;
    nav.toSeries(volume.series_uuid);
  }

  function rotateZoomMode() {
    // Continuous mode has its own zoom settings
    if ($settings.continuousScroll) {
      rotateContinuousZoomMode();
      return;
    }

    const currentMode = $settings.zoomDefault;
    let nextMode: typeof currentMode;

    // Rotate: fitToScreen -> fitToWidth -> fillScreen -> original -> keepZoom -> fitToScreen
    if (currentMode === 'zoomFitToScreen') {
      nextMode = 'zoomFitToWidth';
    } else if (currentMode === 'zoomFitToWidth') {
      nextMode = 'zoomFillScreen';
    } else if (currentMode === 'zoomFillScreen') {
      nextMode = 'zoomOriginal';
    } else if (currentMode === 'zoomOriginal') {
      nextMode = 'keepZoom';
    } else {
      nextMode = 'zoomFitToScreen';
    }

    updateSetting('zoomDefault', nextMode);

    // Show notification with the new mode
    const labels = {
      zoomFitToScreen: 'Fit to Screen',
      zoomFitToWidth: 'Fit to Width',
      zoomFillScreen: 'Fill Screen',
      zoomOriginal: 'Original Size',
      keepZoom: 'Keep Zoom'
    };
    showNotification(labels[nextMode], `zoommode-${nextMode}`);
  }
</script>

<svelte:window
  onresize={() => {
    windowWidth = window.innerWidth;
    windowHeight = window.innerHeight;
    // The paged viewport re-applies its base on resize internally.
  }}
  onkeydown={handleShortcuts}
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
    volumeUuid={volume.volume_uuid}
    page1={pages[index]}
    page2={!useSinglePage ? pages[index + 1] : undefined}
    page1Number={index + 1}
    page2Number={!useSinglePage ? index + 2 : undefined}
    visible={overlaysVisible}
  />
  <SettingsButton visible={overlaysVisible} />
  <TextBoxPicker />
  {#if overlaysVisible}
    <Popover
      placement="bottom"
      trigger="click"
      triggeredBy="#page-num"
      class="z-20 w-full max-w-xs"
    >
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
    <button class="reader-hud fixed top-5 left-5 z-10 opacity-80" id="page-num">
      {#key page}
        <p class="text-left" class:hidden={!$settings.charCount}>{charDisplay}</p>
        <p class="text-left" class:hidden={!$settings.pageNum}>{pageDisplay}</p>
      {/key}
    </button>
  {/if}
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
  {#if $settings.continuousScroll && volumeData?.files}
    {#if effectiveScrollMode === 'vertical'}
      <VerticalScrollReader
        {pages}
        files={volumeData.files}
        {volume}
        {volumeSettings}
        currentPage={page}
        onPageChange={handleContinuousPageChange}
        onVolumeNav={handleContinuousVolumeNav}
        onOverlayToggle={() => (overlaysVisible = !overlaysVisible)}
        onContextMenu={handleTextBoxContextMenu}
      />
    {:else}
      <HorizontalScrollReader
        {pages}
        files={volumeData.files}
        {volume}
        {volumeSettings}
        currentPage={page}
        onPageChange={handleContinuousPageChange}
        onVolumeNav={handleContinuousVolumeNav}
        onVisibleCountChange={(count) => (continuousVisibleCount = count)}
        onOverlayToggle={() => (overlaysVisible = !overlaysVisible)}
        onContextMenu={handleTextBoxContextMenu}
      />
    {/if}
  {:else}
    <!-- Page-based mode -->
    <div class="flex" style:background-color="var(--reader-bg)">
      <PagedViewport
        contentSize={pagedContentSize}
        pageKey={page}
        rtl={volumeSettings.rightToLeft ?? true}
        onPageFlip={(side) => (side === 'left' ? left(null, true) : right(null, true))}
        onOverlayToggle={() => (overlaysVisible = !overlaysVisible)}
      >
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
        <div class="grid" style:filter={$imageFilter} id="manga-panel">
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
                    pageIndex={index + 1}
                    forceVisible={missingPagePaths.has(pages[index + 1]?.img_path)}
                    onContextMenu={handleTextBoxContextMenu}
                  />
                {/if}
                <MangaPage
                  page={pages[index]}
                  src={imageCache.getFile(index)!}
                  cachedUrl={cachedImageUrl1}
                  volumeUuid={volume.volume_uuid}
                  pageIndex={index}
                  forceVisible={missingPagePaths.has(pages[index]?.img_path)}
                  onContextMenu={handleTextBoxContextMenu}
                />
              {:else}
                <div class="flex h-screen w-screen items-center justify-center">
                  <Spinner size="12" />
                </div>
              {/if}
            </div>
          {/key}
        </div>
      </PagedViewport>
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
  {/if}

  {#if showContextMenu && contextMenuData}
    <TextBoxContextMenu
      x={contextMenuData.x}
      y={contextMenuData.y}
      lines={contextMenuData.lines}
      ankiEnabled={$settings.ankiConnectSettings.enabled}
      textBoxElement={contextMenuData.imgElement}
      onCopy={() => {}}
      onCopyRaw={() => {}}
      onAddToAnki={handleContextMenuAddToAnki}
      onClose={() => (showContextMenu = false)}
    />
  {/if}
{:else if volume === null}
  <!-- Still loading from IndexedDB -->
  <div class="fixed top-1/2 left-1/2 z-50">
    <Spinner />
  </div>
{:else}
  <!-- Volume not found or no data -->
  <div class="flex h-screen w-screen flex-col items-center justify-center gap-4">
    <p class="text-lg text-gray-400">Volume not found</p>
    <button
      class="rounded bg-primary-600 px-4 py-2 text-white hover:bg-primary-700"
      onclick={() => navigateBack()}
    >
      Go Back
    </button>
  </div>
{/if}
