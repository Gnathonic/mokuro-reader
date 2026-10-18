/**
 * Which volume the reader has open, and since when. The position sync uses it
 * to tell "opened, not read yet" (move to the newer position, with a toast)
 * from "the user has turned a page here" (leave it to the offer).
 */

let open: { volume: string; openedAt: number } | null = null;

export function noteReaderOpened(volume: string, at: number = Date.now()): void {
  open = { volume, openedAt: at };
}

export function noteReaderClosed(volume: string): void {
  if (open?.volume === volume) open = null;
}

export function openReader(): { volume: string; openedAt: number } | null {
  return open;
}
