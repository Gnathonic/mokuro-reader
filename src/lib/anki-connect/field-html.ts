/**
 * HTML safety for values the reader puts into Anki notes.
 *
 * Anki stores note fields as HTML and renders them unescaped in the reviewer,
 * so anything the reader did not author itself — OCR text, series and volume
 * titles, page filenames — has to reach a field as TEXT. An OCR line reading
 * `<img src=x onerror=…>` would otherwise run as script in the card webview
 * every time the card is reviewed (and that webview's origin is one
 * AnkiConnect allows by default).
 *
 * The user's own field templates and the note's `{existing}` content are the
 * user's Anki markup and stay raw; only the substituted values are escaped.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/**
 * Escape a reader-sourced value for an Anki field. Quotes are escaped too, so
 * the value is also safe inside a quoted attribute of the user's template
 * (`<span title="{sentence}">`). Newlines are kept; `resolveTemplate` turns
 * them into `<br>` afterwards.
 */
export function escapeFieldText(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Make a title safe as part of an Anki tag or deck name. Anki substitutes
 * `{{Tags}}` and `{{Deck}}` into the card unescaped, and a tag cannot carry
 * entities (it is also searched and shown as plain text), so the markup
 * delimiters are swapped for their fullwidth look-alikes — the same
 * substitution titles get as file names (`sanitize-title.ts`). That covers the
 * quotes too: a card template may place `{{Tags}}` or `{{Deck}}` inside a
 * quoted attribute (`class='{{Tags}}'`), and a title's `'` would end it there.
 * `&` stays: an entity decodes to text, never to markup or a closing quote.
 * Whitespace becomes `_`, as Anki tags cannot contain spaces.
 */
export function tagSafeTitle(title: string): string {
  return title
    .replace(/\s+/g, '_')
    .replace(/</g, '＜') // FULLWIDTH LESS-THAN SIGN
    .replace(/>/g, '＞') // FULLWIDTH GREATER-THAN SIGN
    .replace(/"/g, '＂') // FULLWIDTH QUOTATION MARK
    .replace(/'/g, '＇'); // FULLWIDTH APOSTROPHE
}

/**
 * A per-call nonce for internal placeholder tokens, so text that merely
 * contains a token's spelling can never collide with one.
 */
export function placeholderNonce(): string {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return Array.from(words, (w) => w.toString(16).padStart(8, '0')).join('');
}

/**
 * Turn field HTML into a short plain-text preview (the field modal's
 * resolved-value line): `<img>` becomes `[img]`, `<br>` a newline, other tags
 * are dropped and the entities `escapeFieldText` writes are decoded — `&amp;`
 * LAST, so an escaped `&lt;` (`&amp;lt;`) previews as the `&lt;` it was rather
 * than being decoded twice into `<`.
 */
export function fieldHtmlToPreviewText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<img[^>]*>/gi, '[img]')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
