import { describe, expect, it } from 'vitest';
import universe from '../config/universe.json';

interface HistoryConfig {
  source: string;
  symbol: string;
}

interface IndexConfig {
  symbol: string;
  history?: HistoryConfig;
}

describe('market universe configuration', () => {
  it('keeps ranking history enabled for indices that have overview history', () => {
    const overview = universe.indices as IndexConfig[];
    const ranking = universe.rankingIndices as IndexConfig[];
    const missing = overview
      .filter((item) => item.history)
      .filter((item) => !ranking.find((candidate) => candidate.symbol === item.symbol)?.history)
      .map((item) => item.symbol);

    expect(missing).toEqual([]);
  });

  it('keeps Hang Seng TECH in rankings without adding it to overview', () => {
    const overview = universe.indices as Array<IndexConfig & { name?: string; sinaSymbol?: string }>;
    const ranking = universe.rankingIndices as Array<IndexConfig & { name?: string; sinaSymbol?: string }>;
    const item = ranking.find((candidate) => candidate.symbol === 'HSTECH');

    expect(overview.some((candidate) => candidate.symbol === 'HSTECH')).toBe(false);
    expect(item).toMatchObject({
      name: '恒生科技',
      sinaSymbol: 'hkHSTECH',
      history: { source: 'tencent-hk', symbol: 'hkHSTECH' },
    });
  });

  it('uses spot history for Hang Seng and daily USD history for Bitcoin', () => {
    const overview = universe.indices as IndexConfig[];
    const assets = universe.marketAssets as IndexConfig[];

    expect(overview.find((item) => item.symbol === 'HSI')?.history).toEqual({
      source: 'tencent-hk',
      symbol: 'hkHSI',
    });
    expect(assets.find((item) => item.symbol === 'BTC')?.history).toEqual({
      source: 'coinmetrics-crypto',
      symbol: 'BTC',
    });
  });

  it('classifies every default fund and configures a composite healthcare benchmark', () => {
    const funds = universe.funds as Array<{
      code: string;
      strategy?: string;
      estimateMode?: string;
      benchmark?: { id?: string; components?: unknown[] };
      holdings?: unknown[];
    }>;
    const healthcare = funds.find((fund) => fund.code === '004877');

    expect(funds).toHaveLength(18);
    expect(funds.every((fund) => Boolean(fund.strategy))).toBe(true);
    expect(healthcare).toMatchObject({
      strategy: 'healthcare',
      benchmark: {
        id: 'global-healthcare-v1',
      },
    });
    expect(healthcare?.estimateMode).toBeUndefined();
    expect(healthcare?.benchmark?.components).toHaveLength(3);
    expect(healthcare?.holdings).toHaveLength(10);
  });
});
