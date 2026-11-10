// Guard shared by every shortcut outside the reader (the layout's one key
// listener, #55). WHICH key does what is the keymap's business ($lib/keys);
// this only answers "is focus somewhere that types".

/** Is focus somewhere that swallows keys — a field, or any contentEditable? */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return false;
}
