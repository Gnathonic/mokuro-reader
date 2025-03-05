<script lang="ts">
  import { run } from 'svelte/legacy';

  import { currentSeries, currentVolume, currentVolumeData } from '$lib/catalog';
  import {
    Panzoom,
    panzoomStore,
    toggleFullScreen,
    zoomDefault,
    zoomFitToScreen
  } from '$lib/panzoom';
  import { progress, settings, updateProgress, type VolumeSettings } from '$lib/settings';
  import { clamp, debounce, fireExstaticEvent } from '$lib/util';
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
  import { beforeNavigate } from '$app/navigation';
  import { onMount } from 'svelte';

  // TODO: Refactor this whole mess
  interface Props {
    volumeSettings: VolumeSettings;
  }

  let { volumeSettings }: Props = $props();

  let start: Date;

  function mouseDown() {
    start = new Date();
  }

  function left(_e: any, ingoreTimeOut?: boolean) {
    const newPage = volumeSettings.rightToLeft ? page + navAmount : page - navAmount;
    changePage(newPage, ingoreTimeOut);
  }

  function right(_e: any, ingoreTimeOut?: boolean) {
    const newPage = volumeSettings.rightToLeft ? page - navAmount : page + navAmount;
    changePage(newPage, ingoreTimeOut);
  }

  function changePage(newPage: number, ingoreTimeOut = false) {
    const end = new Date();
    const clickDuration = ingoreTimeOut ? 0 : end.getTime() - start?.getTime();

    // Only apply click duration check for mouse/touch events, not for manual input
    if (pages && volume && (ingoreTimeOut || clickDuration < 200)) {
      if (showSecondPage() && page >= pages.length && newPage > page) {
        return;
      }
      const pageClamped = clamp(newPage, 1, pages?.length);
      const { charCount } = getCharCount(pages, pageClamped);
      if (pageClamped !== newPage) {
        let seriesVolumes = $currentSeries;
        const currentVolumeIndex = seriesVolumes.findIndex(
          (v) => v.volume_uuid === volume.volume_uuid
        );
        if (newPage < 1) {
          // open previous volume
          const previousVolume = seriesVolumes[currentVolumeIndex - 1];
          if (previousVolume)
            window.location.href = `/${volume.series_uuid}/${previousVolume.volume_uuid}`;
          else window.location.href = `/${volume.series_uuid}`;
        } else if (newPage > pages.length) {
          // open next volume
          const nextVolume = seriesVolumes[currentVolumeIndex + 1];
          if (nextVolume) window.location.href = `/${volume.series_uuid}/${nextVolume.volume_uuid}`;
          else window.location.href = `/${volume.series_uuid}`;
        }
      } else {
        updateProgress(
          volume.volume_uuid,
          pageClamped,
          charCount,
          pageClamped === pages.length || pageClamped === pages.length - 1
        );
        zoomDefault();
      }
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
    const action = event.code || event.key;

    switch (action) {
      case 'ArrowLeft':
        left(event, true);
        return;
      case 'ArrowUp':
      case 'PageUp':
        changePage(page - navAmount, true);
        return;
      case 'ArrowRight':
        right(event, true);
        return;
      case 'ArrowDown':
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
      case 'Escape':
        window.location.href = `/${volume.series_uuid}`;
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
    if ($panzoomStore && $settings.mobile) {
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
    if ($settings.defaultFullscreen) {
      document.documentElement.requestFullscreen();
    }
  });

  beforeNavigate(() => {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    }

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
  let volume = $derived($currentVolume);
  let volumeData = $derived($currentVolumeData);
  let pages = $derived(volumeData?.pages || []);
  let page = $derived($progress?.[volume?.volume_uuid || 0] || 1);
  let index = $derived(page - 1);
  let navAmount = $derived(
    volumeSettings.singlePageView ||
      (volumeSettings.hasCover && !volumeSettings.singlePageView && index === 0)
      ? 1
      : 2
  );
  let showSecondPage = $derived(() => {
    if (!pages) {
      return false;
    }

    if (volumeSettings.singlePageView || index + 1 >= pages.length) {
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
</script>

<svelte:window
  onresize={zoomDefault}
  onkeyup={handleShortcuts}
  ontouchstart={handleTouchStart}
  ontouchend={handlePointerUp}
/>
<svelte:head>
  <title>{volume?.volume_title || 'Volume'}</title>
</svelte:head>
{#if volume && pages && volumeData}
  <QuickActions
    {left}
    {right}
    src1={Object.values(volumeData.files)[index]}
    src2={!volumeSettings.singlePageView ? Object.values(volumeData.files)[index + 1] : undefined}
  />
  <SettingsButton />
  <Cropper />
  <Popover placement="bottom" trigger="click" triggeredBy="#page-num" class="z-20 w-full max-w-xs">
    <div class="flex flex-col gap-3">
      <div class="flex flex-row items-center gap-5 z-10">
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
          on:click={onInputClick}
          on:change={onManualPageChange}
          on:keydown={(e) => {
            if (e.key === 'Enter') {
              onManualPageChange();
              e.currentTarget.blur();
            }
          }}
          on:blur={onManualPageChange}
        />
        <button onclick={(e) => right(e, true)}>
          <CaretRightSolid class="hover:text-primary-600" size="sm" />
        </button>
        <button onclick={() => changePage(volumeSettings.rightToLeft ? 1 : pages.length, true)}>
          <ForwardStepSolid class="hover:text-primary-600" size="sm" />
        </button>
      </div>
      <div style:direction={volumeSettings.rightToLeft ? 'rtl' : 'ltr'}>
        <Range
          min={1}
          max={pages.length}
          bind:value={manualPage}
          on:change={onManualPageChange}
          defaultClass=""
        />
      </div>
    </div>
  </Popover>
  <button class="absolute opacity-50 left-5 top-5 z-10 mix-blend-difference" id="page-num">
    <p class="text-left" class:hidden={!$settings.charCount}>{charDisplay}</p>
    <p class="text-left" class:hidden={!$settings.pageNum}>{pageDisplay}</p>
  </button>
  <div class="flex" style:background-color={$settings.backgroundColor}>
    <Panzoom>
      <button
        class="h-full fixed -left-full z-10 w-full hover:bg-slate-400 opacity-[0.01]"
        style:margin-left={`${$settings.edgeButtonWidth}px`}
        onmousedown={mouseDown}
        onmouseup={left}
      ></button>
      <button
        class="h-full fixed -right-full z-10 w-full hover:bg-slate-400 opacity-[0.01]"
        style:margin-right={`${$settings.edgeButtonWidth}px`}
        onmousedown={mouseDown}
        onmouseup={right}
      ></button>
      <button
        class="h-screen fixed top-full -left-full z-10 w-[150%] hover:bg-slate-400 opacity-[0.01]"
        onmousedown={mouseDown}
        onmouseup={left}
      ></button>
      <button
        class="h-screen fixed top-full -right-full z-10 w-[150%] hover:bg-slate-400 opacity-[0.01]"
        onmousedown={mouseDown}
        onmouseup={right}
      ></button>
      <div
        class="flex flex-row"
        class:flex-row-reverse={!volumeSettings.rightToLeft}
        style:filter={`invert(${$settings.invertColors ? 1 : 0})`}
        ondblclick={onDoubleTap}
        role="none"
        id="manga-panel"
      >
        {#key page}
          {#if showSecondPage()}
            <MangaPage page={pages[index + 1]} src={Object.values(volumeData.files)[index + 1]} />
          {/if}
          <MangaPage page={pages[index]} src={Object.values(volumeData.files)[index]} />
        {/key}
      </div>
    </Panzoom>
  </div>
  {#if !$settings.mobile}
    <button
      onmousedown={mouseDown}
      onmouseup={left}
      class="left-0 top-0 absolute h-full w-16 hover:bg-slate-400 opacity-[0.01]"
      style:width={`${$settings.edgeButtonWidth}px`}
    ></button>
    <button
      onmousedown={mouseDown}
      onmouseup={right}
      class="right-0 top-0 absolute h-full w-16 hover:bg-slate-400 opacity-[0.01]"
      style:width={`${$settings.edgeButtonWidth}px`}
    ></button>
  {/if}
{:else}
  <div class="fixed z-50 left-1/2 top-1/2">
    <Spinner />
  </div>
{/if}
