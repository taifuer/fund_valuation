import { axisLabelWidth, valueAxis } from './chartLayout';
export { nearestChartPoint as nearestHistoryPoint } from './chartLayout';

export interface AnnualReturn {
  year: number;
  return: number | null;
  startDate: string | null;
  startClose: number | null;
  endDate: string | null;
  endClose: number | null;
  reason: string;
  yearToDate: boolean;
  partialYear?: boolean;
  sourceUrl: string | null;
}

export type LongHistoryRange = '5' | '10' | '20' | '30' | 'all';
export type LongHistoryGroup = 'all' | 'china' | 'usa' | 'asia' | 'assets';

export interface PeriodPerformance {
  startPeriod: string | null;
  endPeriod: string | null;
  startClose?: number | null;
  endClose?: number | null;
  months: number;
  change: number | null;
  cagr: number | null;
  reason: string;
  cagrReason: string;
}

export interface HistoryComparison {
  independentPeriods?: boolean;
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

export function formatHistoryNumber(value: number | null, axis = false) {
  return value == null ? '--' : value.toLocaleString('en-US', {
    maximumFractionDigits: Math.abs(value) < 1 ? 4 : axis && Math.abs(value) >= 100 ? 0 : 2,
  });
}

export function longHistoryChart(points: LongHistoryPoint[], width: number, logarithmic: boolean) {
  const axis = valueAxis(points.map(point => point.close), logarithmic);
  const left = axisLabelWidth(axis.ticks.map(value => formatHistoryNumber(value, true)));
  const right = Math.max(left + 1, width - 18);
  const top = 18;
  const bottom = 254;
  if (!points.length) return { positions: [], ticks: [], path: '', left, right, top, bottom };
  const serial = (period: string) => Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7));
  const first = serial(points[0].period);
  const last = serial(points[points.length - 1].period);
  const positions = points.map((p, i) => ({
    x: left + (last === first ? 0.5 : (serial(p.period) - first) / (last - first)) * (right - left),
    y: top + axis.ratio(p.close) * (bottom - top),
  }));
  const path = positions.map((p, i) => `${i === 0 || serial(points[i].period) - serial(points[i - 1].period) > 1 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const ticks = axis.ticks.map(value => ({ y: top + axis.ratio(value) * (bottom - top), value }));
  return { positions, ticks, path, left, right, top, bottom };
}
