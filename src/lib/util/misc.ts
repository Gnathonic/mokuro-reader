import { get } from 'svelte/store';
import { showSnackbar } from './snackbar';
import { browser } from '$app/environment';
import { currentView } from './hash-router';

export function clamp(num: number, min: number, max: number) {
  return Math.min(Math.max(num, min), max);
}

export function isReader() {
  return get(currentView).type === 'reader';
}

export function isCatalog() {
  return get(currentView).type === 'catalog';
}

let timer: any;

export function debounce(func: () => void, timeout = 50) {
  if (!timer) {
    timer = setTimeout(() => {
      func();
      clearTimeout(timer);
      timer = undefined;
    }, timeout);
  } else {
    clearTimeout(timer);
    timer = undefined;
  }
}

export function toClipboard(event: MouseEvent) {
  const target = event.currentTarget as HTMLElement;
  const text = target.textContent?.trim() || '';
  if (text) {
    navigator.clipboard.writeText(text);
    showSnackbar('Copied to clipboard');
  }
}

type ExtaticPayload = {
  title: string;
  volumeName: string;
  currentCharCount: number;
  totalCharCount: number;
  currentPage: number;
  totalPages: number;
  currentLineCount: number;
  totalLineCount: number;
};

type ExtaticEvent = 'mokuro-reader:page.change' | 'mokuro-reader:reader.closed';

export function fireExstaticEvent(event: ExtaticEvent, payload: ExtaticPayload) {
  if (browser) {
    document.dispatchEvent(new CustomEvent(event, { detail: payload }));
  }
}

/**
 * Reset document scroll position back to origin.
 * This is needed because scrolling in overlays (like settings menu) can
 * affect the underlying document scroll position, which cannot be scrolled
 * back manually due to input overrides.
 */
export function resetScrollPosition() {
  if (window.scrollX !== 0 || window.scrollY !== 0) {
    window.scrollTo(0, 0);
  }
  if (document.documentElement.scrollLeft !== 0 || document.documentElement.scrollTop !== 0) {
    document.documentElement.scrollLeft = 0;
    document.documentElement.scrollTop = 0;
  }
  if (document.body.scrollLeft !== 0 || document.body.scrollTop !== 0) {
    document.body.scrollLeft = 0;
    document.body.scrollTop = 0;
  }
}
