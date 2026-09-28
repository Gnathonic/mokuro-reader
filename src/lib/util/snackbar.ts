import { writable } from 'svelte/store';

type Snackbar = {
  visible: boolean;
  message: string;
};
export const snackbarStore = writable<Snackbar | undefined>(undefined);

let shown = 0;

export function showSnackbar(message: string, duration = 3000) {
  const token = ++shown;
  snackbarStore.set({
    visible: true,
    message
  });

  // Only this message's own timer may clear it: an older message's timer
  // firing later must not wipe a newer message (a failure notice included).
  setTimeout(() => {
    if (token === shown) snackbarStore.set(undefined);
  }, duration);
}
