import type { Issue } from '@aidc/core';
import { useApp } from '../store/appStore.ts';

// Cooling-placement deep link (T4, DECISIONS-v2-2 F8). Lives outside panels/CoolingPanel.tsx so ui/controls.tsx (IssueList) can use it
// without importing a panel module (no controls ↔ panel import cycle); CoolingPanel re-exports both helpers.

export const COOLING_PLACEMENT_ANCHOR = 'cooling-placement';

/** Validation issues whose fix is a CDU / CRAH count or placement change ("CDU를 더 설치하세요"). */
export function isCoolingPlacementIssue(issue: Issue): boolean {
  return issue.domain === 'cooling' && /^cooling-(cdu|crah)/.test(issue.id);
}

export function scrollToCoolingPlacement(): void {
  document.getElementById(COOLING_PLACEMENT_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Opens the cooling page and scrolls to the "냉각 설비 배치" section (for issue lists outside the cooling panel). */
export function openCoolingPlacement(): void {
  const s = useApp.getState();
  if (s.page !== 'cooling') s.setPage('cooling');
  try {
    history.replaceState(null, '', `#${COOLING_PLACEMENT_ANCHOR}`);
  } catch {
    /* sandboxed */
  }
  // the cooling panel mounts on the next render; retry until the anchor exists (≤ ~1 s)
  let tries = 0;
  const tick = () => {
    if (document.getElementById(COOLING_PLACEMENT_ANCHOR) || tries++ > 12) scrollToCoolingPlacement();
    else setTimeout(tick, 80);
  };
  setTimeout(tick, 80);
}
