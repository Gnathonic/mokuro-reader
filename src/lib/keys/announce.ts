/**
 * Feedback for a key press (#55, spec 17.5). In the reader it is the
 * in-overlay notification every hotkey already uses; anywhere else, the
 * snackbar. The reader registers its notification while it is mounted, so
 * callers (the generated-setting handler, later the commands) never ask
 * which one applies.
 */
import { showSnackbar } from '$lib/util/snackbar';

/** One button on a notification: "Set to manual". */
export interface AnnounceAction {
  label: string;
  run: () => void;
}

/**
 * `key` identifies the KIND of message: a repeat replaces the one on screen
 * rather than stacking.
 */
export type Announcer = (message: string, key: string, action?: AnnounceAction) => void;

let readerAnnouncer: Announcer | null = null;

/** The reader's notification, while it is mounted. Returns the un-register. */
export function registerAnnouncer(announcer: Announcer): () => void {
  readerAnnouncer = announcer;
  return () => {
    if (readerAnnouncer === announcer) readerAnnouncer = null;
  };
}

export function announce(message: string, key: string, action?: AnnounceAction) {
  if (readerAnnouncer) readerAnnouncer(message, key, action);
  // The snackbar has no button. Only reader actions announce one, and the
  // reader is mounted whenever they can run.
  else showSnackbar(message);
}
