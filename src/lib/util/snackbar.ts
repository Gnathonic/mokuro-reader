import { writable } from 'svelte/store';

/** A button on a notice, e.g. Undo. */
export type SnackbarAction = { label: string; onClick: () => void };

type Snackbar = {
  visible: boolean;
  message: string;
  action?: SnackbarAction;
};
export const snackbarStore = writable<Snackbar | undefined>(undefined);

let shown = 0;
/** The notice on screen (0 = none): a button of any other is stale. */
let onScreen = 0;
/** Told when the notice on screen goes without its action being used. */
let onGone: (() => void) | undefined;

/**
 * Show a notice for `duration` ms. With `action`, it carries one button (an
 * Undo); `onDismiss` is called once the notice goes WITHOUT that button being
 * pressed — its time ran out or a newer notice replaced it — so whoever
 * offered the action knows it can no longer be taken.
 */
export function showSnackbar(
  message: string,
  duration = 3000,
  action?: SnackbarAction,
  onDismiss?: () => void
) {
  const token = ++shown;
  onScreen = token;
  const replaced = onGone;
  onGone = onDismiss;
  replaced?.();
  snackbarStore.set({
    visible: true,
    message,
    ...(action && {
      action: {
        label: action.label,
        onClick: () => {
          if (token !== onScreen) return;
          onScreen = 0;
          onGone = undefined;
          snackbarStore.set(undefined);
          action.onClick();
        }
      }
    })
  });

  // Only this message's own timer may clear it: an older message's timer
  // firing later must not wipe a newer message (a failure notice included).
  setTimeout(() => {
    if (token !== shown) return;
    onScreen = 0;
    snackbarStore.set(undefined);
    const gone = onGone;
    onGone = undefined;
    gone?.();
  }, duration);
}
