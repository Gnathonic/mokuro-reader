/**
 * Folder names carry the user's variant tag baked in — `One Piece (color)`,
 * `One Piece [bw] (webp)` — so that variants never collide as series. This is
 * the one place that reads it back out: the Link modal searches AniList with
 * the clean base and offers the extracted part as the series' `tag`.
 *
 * Only TRAILING groups count; a leading `[Group]` is part of the name.
 */

/** Bracket pairs recognised as a tag wrapper (ASCII and fullwidth). */
export const BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['(', ')'],
  ['[', ']'],
  ['（', '）'],
  ['【', '】']
];

export interface FolderTagSplit {
  /** The folder name without its trailing bracket groups (trimmed). Never empty when the input isn't. */
  base: string;
  /** The inner text of the trailing groups joined by a space, or undefined when there is none. */
  tag: string | undefined;
}

/**
 * Split `Title (tag)` / `Title [tag]` / `Title [a] (b)` into `{ base, tag }`.
 * Returns the whole name as `base` when nothing can be split off without
 * leaving the base empty, or when a trailing group is empty/unbalanced.
 */
export function splitFolderTag(folderName: string): FolderTagSplit {
  let rest = folderName.trim();
  const groups: string[] = [];

  while (rest) {
    const pair = BRACKET_PAIRS.find(([, close]) => rest.endsWith(close));
    if (!pair) break;
    const [open, close] = pair;
    const openAt = rest.lastIndexOf(open, rest.length - close.length - 1);
    if (openAt < 0) break;
    const inner = rest.slice(openAt + open.length, rest.length - close.length).trim();
    // A nested opener inside the group means this is not a plain tag group.
    if (!inner || inner.includes(open) || inner.includes(close)) break;
    const base = rest.slice(0, openAt).trim();
    if (!base) break;
    groups.unshift(inner);
    rest = base;
  }

  const trimmed = folderName.trim();
  if (groups.length === 0) return { base: trimmed, tag: undefined };
  return { base: rest, tag: groups.join(' ') };
}
