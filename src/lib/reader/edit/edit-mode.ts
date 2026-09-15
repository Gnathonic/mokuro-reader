/**
 * App-level edit-mode switch. The reader owns the `EditSession`; surfaces
 * that are not its children (the settings panel's toggle, the text box
 * context menu routed through the reader, the `E` hotkey) ask for edit mode
 * through `requestEditMode`, and the reader answers by creating or disposing
 * its session and publishing the result on `editModeActive`.
 */
import { writable, readonly } from 'svelte/store';
import type { LineRef } from './edit-session.svelte';

export interface EditModeRequest {
  on: boolean;
  /** Open the line editor on this block once edit mode is up (context menu). */
  focus?: LineRef;
  /** Monotonic, so an identical repeated request is still seen as new. */
  seq: number;
}

const request = writable<EditModeRequest>({ on: false, seq: 0 });
const active = writable(false);

/** What the outside world last asked for. The reader subscribes. */
export const editModeRequest = readonly(request);
/** Whether the reader is in edit mode right now. Set by the reader only. */
export const editModeActive = readonly(active);

export function requestEditMode(on: boolean, focus?: LineRef): void {
  request.update((r) => ({ on, focus, seq: r.seq + 1 }));
}

export function setEditModeActive(on: boolean): void {
  active.set(on);
}
