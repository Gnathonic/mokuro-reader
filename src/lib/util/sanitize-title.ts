/**
 * Make series/volume titles safe as file/folder names on every sync sink:
 * MEGA, Google Drive, WebDAV, OneDrive, the File System Access API, and local export.
 * Illegal characters are substituted with visually-identical fullwidth look-alikes so
 * titles stay human-readable; only control characters are removed.
 */

const FULLWIDTH: Record<string, string> = {
  '/': '／', // FULLWIDTH SOLIDUS
  '\\': '＼', // FULLWIDTH REVERSE SOLIDUS
  ':': '：', // FULLWIDTH COLON
  '*': '＊', // FULLWIDTH ASTERISK
  '?': '？', // FULLWIDTH QUESTION MARK
  '"': '＂', // FULLWIDTH QUOTATION MARK
  '<': '＜', // FULLWIDTH LESS-THAN SIGN
  '>': '＞', // FULLWIDTH GREATER-THAN SIGN
  '|': '｜' // FULLWIDTH VERTICAL LINE
};

const DOT_LEADER = '․'; // ONE DOT LEADER — renders like '.', legal as a filename char
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Sanitize a single path segment (one series OR one volume title).
 * Returns '' when nothing usable remains; callers decide how to treat empty.
 */
export function sanitizeTitleSegment(raw: string): string {
  // 1. strip control chars (code point <= 0x1F) and DEL (0x7F)
  let s = Array.from(raw, (ch) =>
    ch.charCodeAt(0) <= 0x1f || ch.charCodeAt(0) === 0x7f ? '' : ch
  ).join('');
  s = s.replace(/[\\/:*?"<>|]/g, (c) => FULLWIDTH[c]); // 2. fullwidth substitution
  s = s.replace(/^ +| +$/g, ''); // 3. trim leading/trailing spaces
  s = s.replace(/^\.+/, (m) => DOT_LEADER.repeat(m.length)); // 4a. leading dots -> leaders
  s = s.replace(/\.+$/, (m) => DOT_LEADER.repeat(m.length)); // 4b. trailing dots -> leaders
  if (RESERVED_DEVICE_NAME.test(s)) s = `${s}_`; // 5. reserved device names
  return s;
}

export interface SanitizedRename {
  value: string;
  changed: boolean;
  empty: boolean;
}

/** UI convenience: sanitize plus the flags a rename handler needs to notify/block. */
export function sanitizeRenameTitle(raw: string): SanitizedRename {
  const value = sanitizeTitleSegment(raw);
  return { value, changed: value !== raw, empty: value.length === 0 };
}
