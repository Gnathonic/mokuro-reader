/**
 * Could a file of this media type be an image? For covers and thumbnails,
 * which arrive from servers that answer a missing path with an HTML page.
 *
 * Deliberately lenient: an empty type (a Blob that never had one) and
 * `application/octet-stream` (a server that does not know `.webp`) pass, since
 * the image itself may be fine. Only a type that names something else — a
 * page, JSON, text — is refused.
 */
export function mayBeImageType(contentType: string | null | undefined): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return type === '' || type.startsWith('image/') || type === 'application/octet-stream';
}
