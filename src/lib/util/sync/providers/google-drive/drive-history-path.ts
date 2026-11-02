import { HISTORY_FOLDER, isHistoryFilePath } from '$lib/reading-history/paths';

/**
 * Drive lists the whole account flat; every other file type is cached by its
 * immediate parent (`<Series>/<file>`). History is two folders deep, so walk
 * up: file → <device> → history → mokuro-reader. Anything else is not ours.
 */
export function driveHistoryPath(
  file: { name: string; parents?: string[] },
  folders: Map<string, { name: string; parent?: string }>,
  readerFolderName: string
): string | null {
  const device = file.parents?.[0] ? folders.get(file.parents[0]) : undefined;
  const history = device?.parent ? folders.get(device.parent) : undefined;
  const reader = history?.parent ? folders.get(history.parent) : undefined;
  if (!device || history?.name !== HISTORY_FOLDER || reader?.name !== readerFolderName) return null;
  const path = `${HISTORY_FOLDER}/${device.name}/${file.name}`;
  return isHistoryFilePath(path) ? path : null;
}
