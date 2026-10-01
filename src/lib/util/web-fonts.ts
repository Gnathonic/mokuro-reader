/**
 * The OCR text's web font (Noto Sans JP), registered through the FontFace API
 * instead of a `<link rel="stylesheet">`.
 *
 * Google serves Noto Sans JP as ~120 `unicode-range` subsets per weight. As a
 * stylesheet, Chrome dropped and re-decoded every subset in use whenever a
 * media query flipped — any Tailwind breakpoint or the orientation, i.e. every
 * phone rotation — before it could lay the page out again: 0.6–1.3 s of main
 * thread at 4× CPU throttle with a dozen text boxes on screen, against ~50 ms
 * with the same faces added through `document.fonts`. FontFace objects are not
 * tied to the style sheets, so a media query change leaves them alone. They
 * still load lazily: a face is fetched only when text needs its range.
 *
 * Any failure (offline with nothing cached, no FontFace API, an unexpected
 * response) falls back to the stylesheet the app always used.
 */
export const NOTO_SANS_JP_CSS =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&display=swap';

export interface ParsedFontFace {
  family: string;
  source: string;
  descriptors: FontFaceDescriptors;
}

/** The `@font-face` rules of a Google Fonts stylesheet. */
export function parseFontFaceCss(css: string): ParsedFontFace[] {
  const faces: ParsedFontFace[] = [];
  for (const [, body] of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const props = new Map<string, string>();
    for (const decl of body.split(';')) {
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      props.set(decl.slice(0, colon).trim().toLowerCase(), decl.slice(colon + 1).trim());
    }
    const family = props.get('font-family')?.replace(/^['"]|['"]$/g, '');
    const source = props.get('src');
    if (!family || !source) continue;
    const descriptors: FontFaceDescriptors = {};
    const style = props.get('font-style');
    const weight = props.get('font-weight');
    const range = props.get('unicode-range');
    const display = props.get('font-display');
    if (style) descriptors.style = style;
    if (weight) descriptors.weight = weight;
    if (range) descriptors.unicodeRange = range;
    if (display) descriptors.display = display as FontDisplay;
    faces.push({ family, source, descriptors });
  }
  return faces;
}

function addStylesheetFallback(href: string): void {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

let registration: Promise<void> | null = null;

/**
 * Settles once the faces (or the fallback stylesheet) are in the document —
 * at once when nothing ever started loading them (tests, other entry points).
 */
export function webFontsRegistered(): Promise<void> {
  return registration ?? Promise.resolve();
}

/** Register the web font once per page load. */
export function loadWebFonts(href = NOTO_SANS_JP_CSS): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  registration ??= register(href);
  return registration;
}

async function register(href: string): Promise<void> {
  try {
    if (typeof FontFace === 'undefined' || !document.fonts) throw new Error('no FontFace API');
    const response = await fetch(href);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const faces = parseFontFaceCss(await response.text());
    if (faces.length === 0) throw new Error('no @font-face rules');
    for (const { family, source, descriptors } of faces) {
      document.fonts.add(new FontFace(family, source, descriptors));
    }
  } catch (error) {
    console.debug('[web-fonts] falling back to the stylesheet:', error);
    addStylesheetFallback(href);
  }
}
