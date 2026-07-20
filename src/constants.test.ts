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
});
