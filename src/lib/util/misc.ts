import { page } from '$app/stores';
import { get } from 'svelte/store';
import { showSnackbar } from './snackbar';
import { browser } from '$app/environment';

export function clamp(num: number, min: number, max: number) {
  return Math.min(Math.max(num, min), max);
}

export function isReader() {
  return get(page).route.id === '/[manga]/[volume]';
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
