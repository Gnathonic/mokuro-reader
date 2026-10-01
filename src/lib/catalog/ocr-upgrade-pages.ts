import type { Page } from '$lib/types';

/**
 * Pure page helpers for the OCR upgrade (`cloud-ocr-upgrade.ts`): what makes a
 * cloud sidecar's pages "the same OCR" as a volume's, and how its pages are
 * fitted onto the volume's own image files.
 */

/** JSON with object keys sorted at every level: two producers' key orders compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Do these two page sets carry the same OCR? Page for page: the same image
 * dimensions and the same blocks (geometry, font sizes, lines — compared with
 * keys canonically ordered). Deliberately NOT compared: `img_path` (an import
 * remaps it onto the archive's real filenames, see `matchImagesToPages`), the
 * per-page `version` string, and the derived `cumulativeChars`. Those differ
 * between a volume and the very sidecar it was installed from.
 */
export function sameOcrPages(a: readonly Page[], b: readonly Page[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i];
    const pb = b[i];
    if (!pa || !pb) return false;
    if (pa.img_width !== pb.img_width || pa.img_height !== pb.img_height) return false;
    if (canonical(pa.blocks ?? []) !== canonical(pb.blocks ?? [])) return false;
  }
  return true;
}

function stemOf(path: string): string {
  const name = (path.split('/').pop() ?? path).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * The incoming pages in DB shape (`cumulativeChars` stripped — it is derived,
 * never stored), each pointing at the volume's OWN image file.
 *
 * Same length required (the caller already refused anything else). A page
 * keeps the local filename whose stem its own `img_path` names — a re-OCR of
 * the same archive names the same images — and when the stems do not line up
 * one-to-one the pages are matched by POSITION, which is how both sides were
 * ordered in the first place (mokuro and the import both sort the images
 * naturally). The reader matches files to pages by `img_path` first, so a
 * name the device does not have would cost it the fast path.
 */
export function fitPagesToVolume(incoming: readonly Page[], local: readonly Page[]): Page[] {
  const byStem = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const page of local) {
    const stem = stemOf(page.img_path ?? '');
    if (byStem.has(stem)) ambiguous.add(stem);
    else byStem.set(stem, page.img_path);
  }
  const used = new Set<string>();
  let byName: string[] | null = [];
  for (const page of incoming) {
    const stem = stemOf(page.img_path ?? '');
    const path = ambiguous.has(stem) ? undefined : byStem.get(stem);
    if (!path || used.has(path)) {
      byName = null;
      break;
    }
    used.add(path);
    byName.push(path);
  }
  return incoming.map((page, i) => {
    const { cumulativeChars: _derived, ...rest } = page as Page & { cumulativeChars?: number };
    return { ...rest, img_path: byName ? byName[i] : local[i].img_path };
  });
}
