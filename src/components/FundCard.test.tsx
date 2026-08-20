import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FundEstimate } from '../hooks/useQuotes';
import type { Fund, FundEstimateProjection } from '../types';
import FundCard from './FundCard';

const fund: Fund = {
  symbol: '017436',
  code: '017436',
  name: '测试基金',
  holdings: [],
};

function projection(kind: 'pending' | 'preview'): FundEstimateProjection {
  return {
    kind,
    targetDate: kind === 'pending' ? '2026-07-30' : '2026-07-31',
    estimatedNav: kind === 'pending' ? 1.08 : 1.10,
    changePercent: kind === 'pending' ? 2 : 1.85,
    rawChangePercent: kind === 'pending' ? 2 : 1.85,
    cumulativeChangePercent: kind === 'pending' ? 2 : 3.85,
    localChangePercent: 1,
    coverage: 0.7,
    residualWeight: 0.3,
    pricedHoldingCount: 10,
    missingQuoteCount: 0,
    benchmarkSource: 'sina-us',
    benchmarkSymbol: '.NDX',
    model: 'holdingsBenchmark',
    calibration: { applied: false, sampleCount: 0, reason: 'insufficientSamples' },
    phase: kind === 'pending' ? 'CLOSED' : 'PRE',
    complete: kind === 'pending',
    asOf: new Date('2026-07-31T08:18:00+08:00').getTime(),
  };
}

const estimate: FundEstimate = {
  fundCode: fund.code,
  fundName: fund.name,
  fund,
  officialNAV: {
    code: fund.code,
    name: fund.name,
    navDate: '2026-07-29',
    nav: 1.05,
    officialChange: 0.5,
    estimatedNav: 1.05,
    estimatedChange: 0,
  },
  purchaseStatus: null,
  rangeReturns: null,
  computedChangeLocal: 0,
  estimatedNAVLocal: 1.08,
  computedChange: 0,
  estimatedNAV: 1.08,
  normalizedChangeLocal: 0,
  normalizedChange: 2,
  normalizedNAVLocal: 1.08,
  normalizedNAV: 1.08,
  holdingsQuotes: [],
  totalConfiguredWeight: 0.7,
  quoteCoverage: 0.7,
  missingQuoteCount: 0,
  staleQuoteCount: 0,
  missingFxCount: 0,
  lastUpdated: null,
  estimateState: 'CLOSED',
  currencyChanges: {},
  projections: {
    code: fund.code,
    modelVersion: 'test',
    officialNavDate: '2026-07-29',
    officialNav: 1.05,
    officialChange: 0.5,
    holdingReportDate: '2026-06-30',
    pending: projection('pending'),
    preview: projection('preview'),
  },
};

describe('FundCard valuation labels', () => {
  it('shows the completed pending target date by default', () => {
    render(<FundCard fund={fund} estimate={estimate} rank={1} sortMode="pending" loading={false} />);
    expect(screen.getByText('07/30 待公布')).toBeInTheDocument();
    expect(screen.getByText('07/29 已出净值')).toBeInTheDocument();
    expect(screen.queryByText('07/29')).not.toBeInTheDocument();
    expect(screen.getByText('已收盘')).toBeInTheDocument();
    expect(screen.getByText('1.0800')).toBeInTheDocument();
  });

  it('shows the live target date and quote phase in preview mode', () => {
    render(<FundCard fund={fund} estimate={estimate} rank={1} sortMode="preview" loading={false} />);
    expect(screen.getByText('07/31 实时参考')).toBeInTheDocument();
    expect(screen.getByText('07/29 已出净值')).toBeInTheDocument();
    expect(screen.getByText('盘前')).toBeInTheDocument();
    expect(screen.getByText('1.1000')).toBeInTheDocument();
  });

  it('shows only the official NAV for an official-only fund', () => {
    const officialFund: Fund = {
      ...fund,
      strategy: 'healthcare',
      estimateMode: 'official',
    };
    const officialEstimate: FundEstimate = {
      ...estimate,
      fund: officialFund,
      fundCode: officialFund.code,
      fundName: officialFund.name,
    };

    render(<FundCard fund={officialFund} estimate={officialEstimate} rank={4} sortMode="preview" loading={false} />);

    expect(screen.getByText('医疗健康')).toBeInTheDocument();
    expect(screen.getByText('仅官方净值')).toBeInTheDocument();
    expect(screen.getByText('1.0500')).toBeInTheDocument();
    expect(screen.queryByText('1.1000')).not.toBeInTheDocument();
    expect(screen.queryByText('盘前')).not.toBeInTheDocument();
  });

  it('does not show a normalized fallback while a composite benchmark is preparing', async () => {
    const compositeFund: Fund = {
      ...fund,
      benchmark: {
        id: 'medical-v1',
        components: [
          { source: 'sina-us', symbol: 'IXJ', currency: 'USD', weight: 0.8 },
          { kind: 'stable', symbol: 'CASH', currency: 'CNY', weight: 0.2 },
        ],
      },
    };
    const preparingEstimate: FundEstimate = {
      ...estimate,
      fund: compositeFund,
      projections: null,
    };

    render(<FundCard fund={compositeFund} estimate={preparingEstimate} rank={4} sortMode="preview" loading={false} />);

    expect(screen.getByText('代理准备中')).toBeInTheDocument();
    expect(screen.queryByText('1.0800')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /展开详情/ }));
    expect(await screen.findByText('复合代理数据准备中，暂不生成估值。')).toBeInTheDocument();
  });
});
