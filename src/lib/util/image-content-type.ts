/**
 * Could a file of this media type be an image? For covers and thumbnails,
 * which arrive from servers that answer a missing path with an HTML page.
 *
 * A cheap pre-filter on a response header, never the decision: what a stored
 * image IS comes from its bytes alone (`toRasterImageFile`,
 * `$lib/util/raster-image`).
 *
 * Deliberately lenient: an empty type (a Blob that never had one) and
 * `application/octet-stream` (a server that does not know `.webp`) pass, since
 * the image itself may be fine. A type that names something else — a page,
 * JSON, text — is refused, and so is SVG: the app supports raster formats
 * only, and an SVG is a document that can carry script.
 */
export function mayBeImageType(contentType: string | null | undefined): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type === '' || type === 'application/octet-stream') return true;
  return type.startsWith('image/') && !type.includes('svg') && !type.includes('xml');
}
