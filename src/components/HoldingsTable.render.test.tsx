import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FundEstimateProjection, Holding, QuoteData } from '../types';
import HoldingsTable from './HoldingsTable';

const holding: Holding = {
  symbol: 'AMD',
  name: 'AMD',
  sinaSymbol: 'gb_amd',
  weight: 0.1,
  currency: 'USD',
  reportDate: '2026-06-30',
};

const quote: QuoteData = {
  symbol: 'gb_amd',
  name: 'AMD',
  price: 107,
  previousClose: 100,
  change: 7,
  changePercent: 7,
  time: '2026-08-05 07:59:00',
  dateReliable: true,
  fetchedAt: Date.now(),
  session: 'post',
};

const projection = {
  kind: 'preview',
  targetDate: '2026-08-05',
  comparisonDate: '2026-08-04',
  estimatedNav: 0.997,
  changePercent: -0.3,
  rawChangePercent: -0.3,
  cumulativeChangePercent: -0.3,
  localChangePercent: -0.2,
  coverage: 0.1,
  residualWeight: 0.9,
  pricedHoldingCount: 1,
  missingQuoteCount: 0,
  benchmarkSource: 'sina-us',
  benchmarkSymbol: '.NDX',
  model: 'holdingsBenchmark',
  calibration: { applied: false, sampleCount: 0, reason: 'insufficientSamples' },
  phase: 'POST',
  complete: false,
  asOf: Date.now(),
  holdingContributions: [{
    sinaSymbol: 'gb_amd',
    symbol: 'AMD',
    name: 'AMD',
    weight: 0.1,
    currency: 'USD',
    basePrice: 100,
    targetPrice: 98,
    priceChangePercent: -2,
    baseFxRate: 7,
    targetFxRate: 7,
    fxChangePercent: 0,
    combinedChangePercent: -2,
    contributionPercent: -0.2,
  }],
  holdingContributionPercent: -0.2,
  residualContributionPercent: -0.1,
  calibrationContributionPercent: 0,
} satisfies FundEstimateProjection;

describe('HoldingsTable projection details', () => {
  const props = {
    quotes: [quote], computedChange: 0.7, normalizedChange: 7, quoteCoverage: 0.1,
    totalConfiguredWeight: 0.1, missingQuoteCount: 0, staleQuoteCount: 0,
    missingFxCount: 0, currencyChanges: { USD: 0 },
  };

  it('does not invent a contribution for rows omitted by the server projection', () => {
    render(<HoldingsTable {...props} holdings={[holding]} projectionRequired
      projection={{...projection, holdingContributions:[]}} />);
    expect(screen.getByText('未计入')).toBeInTheDocument();
    expect(screen.queryByText('+7.00%')).not.toBeInTheDocument();
    expect(screen.queryByText('+0.70%')).not.toBeInTheDocument();
  });

  it('keeps expanded portfolios compact without changing calculation totals', () => {
    const rows = Array.from({length:30}, (_, index) => ({...holding, symbol:`S${index}`}));
    render(<HoldingsTable {...props} holdings={rows} />);
    expect(screen.getAllByRole('row')).toHaveLength(21);
    fireEvent.click(screen.getByRole('button', {name:'显示全部 30 项'}));
    expect(screen.getAllByRole('row')).toHaveLength(31);
    fireEvent.click(screen.getByRole('button', {name:'收起'}));
    expect(screen.getAllByRole('row')).toHaveLength(21);
  });
  it('uses date-aligned contribution data instead of the raw quote change', () => {
    render(
      <HoldingsTable
        holdings={[holding]}
        quotes={[quote]}
        computedChange={0.7}
        normalizedChange={7}
        quoteCoverage={0.1}
        totalConfiguredWeight={0.1}
        missingQuoteCount={0}
        staleQuoteCount={0}
        missingFxCount={0}
        currencyChanges={{ USD: 0 }}
        projection={projection}
      />,
    );

    expect(screen.getByText('98')).toBeInTheDocument();
    expect(screen.getByText('-2.00%')).toBeInTheDocument();
    expect(screen.getByText('-0.20%')).toBeInTheDocument();
    expect(screen.getByText('-0.30%')).toBeInTheDocument();
    expect(screen.getByText(/未披露仓位 -0.10%/)).toBeInTheDocument();
    expect(screen.queryByText('+7.00%')).not.toBeInTheDocument();
  });

  it('explains when the estimate falls back to normalized covered holdings', () => {
    render(
      <HoldingsTable
        holdings={[holding]}
        quotes={[quote]}
        computedChange={0.7}
        normalizedChange={7}
        quoteCoverage={0.1}
        totalConfiguredWeight={0.1}
        missingQuoteCount={0}
        staleQuoteCount={0}
        missingFxCount={0}
        currencyChanges={{ USD: 0 }}
        projection={{ ...projection, model: 'coverageNormalizedFallback' }}
      />,
    );

    expect(screen.getByText('未披露仓位暂无稳定基准，本次估算按已覆盖持仓权重归一化。')).toBeInTheDocument();
  });
});
