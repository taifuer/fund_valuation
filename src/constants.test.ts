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
});
