import universe from '../config/universe.json';
import type { Fund, IndexConfig } from './types';


function indexConfigs(value: unknown): IndexConfig[] {
  return Array.isArray(value) ? value as IndexConfig[] : [];
}

function fundConfigs(value: unknown): Fund[] {
  return Array.isArray(value) ? value as Fund[] : [];
}

export const INDICES = indexConfigs(universe.indices);
export const MARKET_ASSETS = indexConfigs(universe.marketAssets);
export const ETF_ASSETS = indexConfigs(universe.etfAssets);
export const RANKING_INDICES = indexConfigs(universe.rankingIndices);
export const RANKING_SECTOR_ETFS = indexConfigs(universe.rankingSectorEtfs);
export const RANKING_INDEX_ETFS = indexConfigs(universe.rankingIndexEtfs);
export const RANKING_ETFS: IndexConfig[] = [...RANKING_INDEX_ETFS, ...RANKING_SECTOR_ETFS];
export const FUNDS = fundConfigs(universe.funds);

export const COLORS = { up: '#16a34a', down: '#dc2626' } as const;
