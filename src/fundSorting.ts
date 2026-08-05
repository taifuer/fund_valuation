import type { FundEstimate } from './hooks/useQuotes';

export type FundSortMode = 'pending' | 'preview' | 'official';
export type FundSortDirection = 'desc' | 'asc';
export type FundSortGroup = 'pending' | 'published' | 'primary';

export interface RankedFundEstimate {
  estimate: FundEstimate;
  rank: number;
  group: FundSortGroup;
  groupStart: boolean;
  groupCount: number;
}

function groupFor(estimate: FundEstimate, mode: FundSortMode): FundSortGroup {
  if (mode !== 'pending') return 'primary';
  return estimate.projections?.pending ? 'pending' : 'published';
}

function valueFor(estimate: FundEstimate, mode: FundSortMode, group: FundSortGroup): number | null {
  if (mode === 'official') return estimate.officialNAV?.officialChange ?? null;
  if (mode === 'preview') {
    return estimate.projections?.preview?.changePercent
      ?? estimate.projections?.pending?.changePercent
      ?? (estimate.normalizedNAVLocal === null ? null : estimate.normalizedChange);
  }
  if (group === 'pending') return estimate.projections?.pending?.changePercent ?? null;
  return estimate.projections?.preview?.changePercent
    ?? estimate.officialNAV?.officialChange
    ?? null;
}

function targetDateFor(estimate: FundEstimate, mode: FundSortMode, group: FundSortGroup): string {
  if (mode === 'official') return estimate.officialNAV?.navDate ?? '';
  if (mode === 'preview') {
    return estimate.projections?.preview?.targetDate
      ?? estimate.projections?.pending?.targetDate
      ?? '';
  }
  return group === 'pending'
    ? estimate.projections?.pending?.targetDate ?? ''
    : estimate.projections?.preview?.targetDate ?? estimate.officialNAV?.navDate ?? '';
}

export function rankFundEstimates(
  estimates: FundEstimate[],
  mode: FundSortMode,
  direction: FundSortDirection,
): RankedFundEstimate[] {
  const sorted = [...estimates].sort((a, b) => {
    const aGroup = groupFor(a, mode);
    const bGroup = groupFor(b, mode);
    if (aGroup !== bGroup) return aGroup === 'pending' ? -1 : 1;

    const aDate = targetDateFor(a, mode, aGroup);
    const bDate = targetDateFor(b, mode, bGroup);
    if (aDate !== bDate) return bDate.localeCompare(aDate);

    const aValue = valueFor(a, mode, aGroup);
    const bValue = valueFor(b, mode, bGroup);
    if (aValue === null && bValue === null) return a.fundName.localeCompare(b.fundName);
    if (aValue === null) return 1;
    if (bValue === null) return -1;
    const valueOrder = direction === 'desc' ? bValue - aValue : aValue - bValue;
    return valueOrder || a.fundName.localeCompare(b.fundName);
  });

  const ranks: Record<FundSortGroup, number> = { pending: 0, published: 0, primary: 0 };
  const groupCounts = sorted.reduce<Record<FundSortGroup, number>>((counts, estimate) => {
    counts[groupFor(estimate, mode)] += 1;
    return counts;
  }, { pending: 0, published: 0, primary: 0 });
  let previousGroup: FundSortGroup | null = null;
  return sorted.map((estimate) => {
    const group = groupFor(estimate, mode);
    ranks[group] += 1;
    const groupStart = group !== previousGroup;
    previousGroup = group;
    return { estimate, rank: ranks[group], group, groupStart, groupCount: groupCounts[group] };
  });
}
