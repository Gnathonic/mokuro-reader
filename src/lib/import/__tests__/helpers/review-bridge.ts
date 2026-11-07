/**
 * Test stand-in for the image-only review dialog (#285): installs a
 * `reviewImageOnly` bridge that records every group offered and decides it —
 * at once, like a user accepting the dialog's defaults, or by hand ('manual').
 */

import { get } from 'svelte/store';
import { miscSettings } from '$lib/settings/misc';
import { getImportUiBridge, setImportUiBridge } from '../../import-ui';
import { defaultNaming, type GroupNaming, type ReviewGroup } from '../../image-only-review';
import type { GroupDecision } from '../../review-session';

/** What the dialog shows first: the last mode used, numbering after the series' volumes. */
export function dialogDefaults(group: ReviewGroup): GroupNaming {
  return defaultNaming(group, get(miscSettings).keepFolderNamesAsTitles ? 'folder' : 'cleaned');
}

export function approveAsDialogWould(group: ReviewGroup): GroupDecision {
  return { action: 'import', naming: dialogDefaults(group) };
}

export interface Reviewer {
  /** Every group offered, in order. */
  offered: ReviewGroup[];
  /** 'manual' only: groups waiting for `decide`. */
  pending: { group: ReviewGroup; decide: (decision: GroupDecision) => void }[];
  restore: () => void;
}

export function installReviewer(
  decide: ((group: ReviewGroup) => GroupDecision) | 'manual' = approveAsDialogWould
): Reviewer {
  const original = getImportUiBridge();
  const reviewer: Reviewer = {
    offered: [],
    pending: [],
    restore: () => setImportUiBridge(original)
  };
  setImportUiBridge({
    ...original,
    reviewImageOnly(groups, onDecision) {
      for (const group of groups) {
        reviewer.offered.push(group);
        if (decide === 'manual') {
          reviewer.pending.push({ group, decide: (d) => onDecision(group.id, d) });
        } else {
          onDecision(group.id, decide(group));
        }
      }
    }
  });
  return reviewer;
}
