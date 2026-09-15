export interface AnnualReturn {
  year: number;
  return: number | null;
  startDate: string | null;
  startClose: number | null;
  endDate: string | null;
  endClose: number | null;
  reason: string;
  yearToDate: boolean;
  sourceUrl: string | null;
}

export type LongHistoryRange = '5' | '10' | '20' | 'all';
export type LongHistoryGroup = 'all' | 'china' | 'usa' | 'asia' | 'assets';

export interface PeriodPerformance {
  startPeriod: string | null;
  endPeriod: string | null;
  months: number;
  change: number | null;
  cagr: number | null;
  reason: string;
  cagrReason: string;
}

export interface HistoryComparison {
  startPeriod: string | null;
  endPeriod: string | null;
  rows: Array<PeriodPerformance & { id: string }>;
}

export interface LongHistoryAsset {
  id: string;
  name: string;
  group: 'china' | 'usa' | 'asia' | 'assets';
  basis: 'price' | 'futures';
  unit: string;
  firstDate: string | null;
  lastDate: string | null;
  count: number;
  completedThrough?: string;
  missingMonths?: string[];
  sources: string[];
  note: string;
  refreshFailed: boolean;
  annual: AnnualReturn[];
  performance?: Record<LongHistoryRange, PeriodPerformance>;
}

export interface LongHistoryPoint {
  period: string;
  date: string;
  close: number;
  source: string;
  sourceUrl: string;
}

export interface LongHistoryCatalog {
  schemaVersion: 1;
  generatedAt: number;
  year: number;
  assets: LongHistoryAsset[];
  comparisons?: Record<LongHistoryGroup, Record<LongHistoryRange, HistoryComparison>>;
}

export interface LongHistorySeries {
  schemaVersion: 1;
  generatedAt: number;
  asset: LongHistoryAsset;
  points: LongHistoryPoint[];
}

export function longHistoryChart(points: LongHistoryPoint[], width: number, logarithmic: boolean) {
  const left = 62;
  const right = Math.max(left + 1, width - 18);
  const top = 18;
  const bottom = 254;
  if (!points.length) return { positions: [], ticks: [], path: '', left, right, top, bottom };
  const values = points.map(p => logarithmic && p.close > 0 ? Math.log(p.close) : p.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(Math.abs(max) * 0.1, 1);
  const lower = min === max ? min - span / 2 : min;
  const upper = min === max ? max + span / 2 : max;
  const serial = (period: string) => Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7));
  const first = serial(points[0].period);
  const last = serial(points[points.length - 1].period);
  const positions = points.map((p, i) => ({
    x: left + (last === first ? 0.5 : (serial(p.period) - first) / (last - first)) * (right - left),
    y: top + (upper - values[i]) / span * (bottom - top),
  }));
  const path = positions.map((p, i) => `${i === 0 || serial(points[i].period) - serial(points[i - 1].period) > 1 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const ticks = Array.from({ length: 5 }, (_, i) => {
    const value = upper - span * i / 4;
    return { y: top + (bottom - top) * i / 4, value: logarithmic ? Math.exp(value) : value };
  });
  return { positions, ticks, path, left, right, top, bottom };
}

export function nearestHistoryPoint(x: number, positions: Array<{ x: number }>): number | null {
  if (!positions.length) return null;
  let left = 0;
  let right = positions.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (positions[mid].x < x) left = mid + 1;
    else right = mid;
  }
  return left > 0 && x - positions[left - 1].x < positions[left].x - x ? left - 1 : left;
}
