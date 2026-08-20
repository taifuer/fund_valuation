import { describe, expect, it } from 'vitest';
import type { FundEstimate } from './hooks/useQuotes';
import { rankFundEstimates } from './fundSorting';

function estimate(
  code: string,
  options: { pending?: number; preview?: number; official?: number; officialDate?: string; officialOnly?: boolean },
): FundEstimate {
  const projection = (kind: 'pending' | 'preview', changePercent: number) => ({
    kind,
    targetDate: kind === 'pending' ? '2026-08-04' : '2026-08-05',
    changePercent,
  });
  return {
    fundCode: code,
    fundName: code,
    fund: {
      code,
      symbol: code,
      name: code,
      holdings: [],
      estimateMode: options.officialOnly ? 'official' : 'holdings',
    },
    officialNAV: {
      code,
      name: code,
      navDate: options.officialDate ?? '2026-08-04',
      nav: 1,
      officialChange: options.official ?? 0,
      estimatedNav: 1,
      estimatedChange: 0,
    },
    normalizedNAVLocal: 1,
    normalizedChange: 0,
    projections: {
      code,
      modelVersion: 'test',
      officialNavDate: options.officialDate ?? '2026-08-04',
      officialNav: 1,
      officialChange: options.official ?? 0,
      holdingReportDate: '2026-06-30',
      pending: options.pending == null ? null : projection('pending', options.pending),
      preview: options.preview == null ? null : projection('preview', options.preview),
    },
  } as unknown as FundEstimate;
}

describe('rankFundEstimates', () => {
  it('keeps genuine pending estimates ahead of a separately ranked published group', () => {
    const ranked = rankFundEstimates([
      estimate('published-low', { preview: -1 }),
      estimate('pending', { pending: 2, preview: 9, officialDate: '2026-08-03' }),
      estimate('published-high', { preview: 1 }),
    ], 'pending', 'desc');

    expect(ranked.map((item) => [item.estimate.fundCode, item.group, item.rank])).toEqual([
      ['pending', 'pending', 1],
      ['published-high', 'published', 1],
      ['published-low', 'published', 2],
    ]);
    expect(ranked.map((item) => item.groupStart)).toEqual([true, true, false]);
  });

  it('sorts the real-time page as one comparable group', () => {
    const ranked = rankFundEstimates([
      estimate('low', { preview: -1 }),
      estimate('high', { preview: 1 }),
    ], 'preview', 'desc');

    expect(ranked.map((item) => [item.estimate.fundCode, item.group, item.rank])).toEqual([
      ['high', 'primary', 1],
      ['low', 'primary', 2],
    ]);
  });

  it('keeps official-only funds out of estimate ranking values', () => {
    const pending = rankFundEstimates([
      estimate('official-only', { official: 9, officialOnly: true, officialDate: '2026-08-06' }),
      estimate('published', { preview: -1 }),
      estimate('pending', { pending: 1 }),
    ], 'pending', 'desc');
    const preview = rankFundEstimates([
      estimate('official-only', { official: 9, officialOnly: true, officialDate: '2026-08-06' }),
      estimate('estimated', { preview: -1 }),
    ], 'preview', 'desc');

    expect(pending.map((item) => [item.estimate.fundCode, item.group])).toEqual([
      ['pending', 'pending'],
      ['published', 'published'],
      ['official-only', 'officialOnly'],
    ]);
    expect(preview.map((item) => item.estimate.fundCode)).toEqual(['estimated', 'official-only']);
  });

  it('does not rank a preparing composite fund by its normalized holdings fallback', () => {
    const preparing = estimate('preparing-composite', {});
    preparing.normalizedChange = 99;
    preparing.fund.benchmark = {
      id: 'medical-v1',
      components: [{ kind: 'stable', symbol: 'CASH', currency: 'CNY', weight: 1 }],
    };

    const ranked = rankFundEstimates([
      preparing,
      estimate('estimated', { preview: -1 }),
    ], 'preview', 'desc');

    expect(ranked.map((item) => item.estimate.fundCode)).toEqual(['estimated', 'preparing-composite']);
  });
});
