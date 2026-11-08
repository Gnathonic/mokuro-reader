// Guard shared by the library's hover shortcuts (series editor, delete, volume
// editor, cover). WHICH key does what is the keymap's business ($lib/keys, #55);
// this only answers "may a library shortcut fire at all right now".

/** Is focus somewhere that swallows keys — a field, or any contentEditable? */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return false;
}
