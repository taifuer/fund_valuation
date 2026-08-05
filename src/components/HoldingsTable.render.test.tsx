import { render, screen } from '@testing-library/react';
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
});
