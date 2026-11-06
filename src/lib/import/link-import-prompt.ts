/**
 * What the import-by-link confirmation says (`#/upload?cbz=…` / `?source=…`).
 *
 * The link was written by someone else, so before anything is fetched the
 * user sees WHERE it will be fetched from — every host the link names, large —
 * with a plain-words warning for a host that is not https or that points at
 * this device or the local network, and is asked before the link's series info
 * may change a series that is already in the library.
 */

import type { ConfirmationDetails } from '$lib/util/modals';
import { describeLinkTarget, linkTargetWarnings, type LinkTarget } from '$lib/util/link-safety';
import { sanitizeTitleSegment } from '$lib/util/sanitize-title';
import type { HtmlDownloadRequest } from './html-download-provider';
import { protectedSeriesKey } from './series-file-import';

export interface LinkImportPrompt extends ConfirmationDetails {
  message: string;
  source: { label: string; values: string[] };
  warnings: string[];
  notes: string[];
  /**
   * Offered whenever the series the link names is already here — a manifest
   * can list a `series.json`, and any archive can carry one inside it: the box
   * that lets it update that series. Never remembered — each link is a fresh
   * decision.
   */
  seriesUpdate?: { label: string; seriesKey: string };
}

/**
 * The volume name as the link spells it. `parseHtmlDownloadRequest` already
 * decoded it once; a second decode is kept for links that double-encode, and
 * skipped for a name that merely contains a `%` ("100% Love").
 */
export function linkDisplayName(request: HtmlDownloadRequest): string {
  try {
    return decodeURIComponent(request.volume);
  } catch {
    return request.volume;
  }
}

/** Every URL the link itself names, in the order they matter. */
function linkTargets(request: HtmlDownloadRequest): LinkTarget[] {
  const raw = [
    request.cbzUrl ?? request.source,
    request.manifestUrl,
    request.cover && /^https?:\/\//i.test(request.cover) ? request.cover : undefined
  ];
  // A directory-mode `source` may be relative: it is fetched against this page.
  const base = typeof window !== 'undefined' ? window.location.href : undefined;
  const targets: LinkTarget[] = [];
  for (const url of raw) {
    if (!url) continue;
    const target = describeLinkTarget(url, base);
    if (target) targets.push(target);
  }
  return targets;
}

/**
 * Build the confirmation for one import link.
 *
 * @param localSeries the library's series keys (`localSeriesKeys`, the
 *   `protectedSeriesKey` fold), so the prompt can say the volume joins a
 *   series already here.
 */
export function buildLinkImportPrompt(
  request: HtmlDownloadRequest,
  localSeries: ReadonlySet<string>
): LinkImportPrompt {
  const displayName = linkDisplayName(request);
  const targets = linkTargets(request);

  // One line per host — a link naming the same server three times is one
  // server — but every target is judged: `https://a.example` and
  // `http://a.example` are one host and only one of them is secure.
  const hosts: string[] = [];
  const warnings: string[] = [];
  for (const target of targets) {
    if (!hosts.includes(target.host)) hosts.push(target.host);
    for (const warning of linkTargetWarnings(target)) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }

  const notes: string[] = [
    'Only continue if you trust this site: the files it sends are added to your library.'
  ];
  let seriesUpdate: LinkImportPrompt['seriesUpdate'];
  const seriesKey = protectedSeriesKey(sanitizeTitleSegment(request.manga));
  if (request.manga && localSeries.has(seriesKey)) {
    notes.push(`“${request.manga}” is already in your library; this volume is added to it.`);
    notes.push(
      `Its series info (AniList link, titles, tag) is left as it is, unless you tick the box below.`
    );
    seriesUpdate = {
      label: `Let this link update the series info of “${request.manga}”`,
      seriesKey
    };
  }

  return {
    message: `Import ${displayName} into your catalog?`,
    source: { label: 'Downloads from', values: hosts },
    warnings,
    notes,
    confirmLabel: 'Import',
    cancelLabel: 'Cancel',
    focusCancel: true,
    ...(seriesUpdate ? { seriesUpdate } : {})
  };
}
