import { useEffect, useMemo, useState } from 'react';
import { fetchFundHistorySeries } from '../api';
import type { FundHistoryPoint } from '../types';
import styles from './FundHistoryChart.module.css';

interface Props {
  fundCode: string;
}

type RangeKey = '1w' | '1m' | '3m' | '6m' | '1y' | '3y' | '5y' | 'ytd' | 'all';
type TextAnchor = 'start' | 'middle' | 'end';

const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: '1w', label: '1周', days: 7 },
  { key: '1m', label: '1月', days: 30 },
  { key: '3m', label: '3月', days: 90 },
  { key: '6m', label: '半年', days: 183 },
  { key: '1y', label: '1年', days: 365 },
  { key: '3y', label: '3年', days: 365 * 3 },
  { key: '5y', label: '5年', days: 365 * 5 },
  { key: 'ytd', label: '今年', days: null },
  { key: 'all', label: '成立来', days: null },
];

const historyCache = new Map<string, FundHistoryPoint[]>();

function formatDate(date: string): string {
  const match = date.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}/${match[2]}` : date;
}

function formatAxisDate(date: string, range: RangeKey): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date;
  const [, year, month, day] = match;
  if (range === '1w' || range === '1m' || range === '3m' || range === '6m' || range === 'ytd') {
    return `${month}/${day}`;
  }
  if (range === '1y') {
    return `${year}/${month}`;
  }
  return year;
}

function tickCount(range: RangeKey): number {
  if (range === '1w') return 6;
  if (range === '1m') return 6;
  if (range === '3m') return 5;
  if (range === '6m') return 7;
  if (range === '1y') return 7;
  return 5;
}

function evenlySpacedIndices(length: number, count: number): number[] {
  if (length <= 0) return [];
  if (length <= count) return Array.from({ length }, (_, index) => index);
  return Array.from({ length: count }, (_, index) => Math.round((index / (count - 1)) * (length - 1)))
    .filter((value, index, values) => values.indexOf(value) === index);
}

function cutoffDate(latestDate: string, days: number): string {
  const date = new Date(`${latestDate}T12:00:00+08:00`);
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function selectRange(points: FundHistoryPoint[], days: number | null): FundHistoryPoint[] {
  if (points.length <= 2 || days === null) return points;
  const latest = points[points.length - 1];
  const cutoff = cutoffDate(latest.date, days);
  const firstAfterCutoff = points.findIndex((point) => point.date >= cutoff);
  if (firstAfterCutoff <= 0) return points;
  const startIndex = points[firstAfterCutoff].date === cutoff ? firstAfterCutoff : firstAfterCutoff - 1;
  const sliced = points.slice(startIndex);
  return sliced.length >= 2 ? sliced : points.slice(-2);
}

function selectYearToDate(points: FundHistoryPoint[]): FundHistoryPoint[] {
  if (points.length <= 2) return points;
  const latest = points[points.length - 1];
  const yearStart = `${latest.date.slice(0, 4)}-01-01`;
  const firstThisYear = points.findIndex((point) => point.date >= yearStart);
  if (firstThisYear <= 0) return points;
  const sliced = points.slice(firstThisYear);
  return sliced.length >= 2 ? sliced : points.slice(-2);
}

function maxDrawdown(points: FundHistoryPoint[]): number {
  let peak = points[0]?.nav ?? 0;
  let worst = 0;
  for (const point of points) {
    peak = Math.max(peak, point.nav);
    if (peak > 0) {
      worst = Math.min(worst, ((point.nav - peak) / peak) * 100);
    }
  }
  return worst;
}

function makeChart(points: FundHistoryPoint[]) {
  if (points.length === 0) {
    return { path: '', min: 0, max: 0, xStart: 56, xEnd: 584, yTicks: [], pointPositions: [] };
  }
  const width = 640;
  const padLeft = 56;
  const padRight = 56;
  const padY = 14;
  const plotHeight = 180;
  const min = Math.min(...points.map((point) => point.nav));
  const max = Math.max(...points.map((point) => point.nav));
  const span = max - min || 1;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = plotHeight - padY * 2;

  const pointPositions = points.map((point, index) => {
      const x = padLeft + (points.length === 1 ? innerWidth : (index / (points.length - 1)) * innerWidth);
      const y = padY + ((max - point.nav) / span) * innerHeight;
      return { x, y };
  });
  const yTicks = evenlySpacedIndices(5, 5).map((_, index) => {
    const value = max - (span * index) / 4;
    const y = padY + index * (innerHeight / 4);
    return { value, y };
  });

  const path = pointPositions
    .map(({ x, y }, index) => {
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return {
    path,
    min,
    max,
    xStart: padLeft,
    xEnd: padLeft + innerWidth,
    yTicks,
    pointPositions,
  };
}

function makeXTicks(points: FundHistoryPoint[], range: RangeKey, xStart: number, xEnd: number) {
  if (points.length === 0) return [];
  const innerWidth = xEnd - xStart;

  if (range === '3y' || range === '5y' || range === 'all') {
    const byYear = new Map<string, number>();
    points.forEach((point, index) => {
      const year = point.date.slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, index);
    });
    const entries = [...byYear.entries()];
    const maxLabels = range === 'all' ? 8 : entries.length;
    const step = Math.max(1, Math.ceil(entries.length / maxLabels));
    const selected = entries.filter((_, index) => index % step === 0);
    if (entries.length > 0 && selected[selected.length - 1]?.[0] !== entries[entries.length - 1][0]) {
      selected.push(entries[entries.length - 1]);
    }
    return selected.map(([label, index]) => {
      const x = xStart + (points.length === 1 ? innerWidth : (index / (points.length - 1)) * innerWidth);
      const anchor: TextAnchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
      return { x, label, anchor };
    });
  }

  return evenlySpacedIndices(points.length, tickCount(range)).map((index) => {
    const x = xStart + (points.length === 1 ? innerWidth : (index / (points.length - 1)) * innerWidth);
    const anchor: TextAnchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
    return {
      x,
      label: formatAxisDate(points[index].date, range),
      anchor,
    };
  });
}

function pointerSvgX(event: React.PointerEvent<SVGSVGElement>): number {
  const svg = event.currentTarget;
  const matrix = svg.getScreenCTM();
  if (!matrix) {
    const rect = svg.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * 640;
  }
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(matrix.inverse()).x;
}

export default function FundHistoryChart({ fundCode }: Props) {
  const [range, setRange] = useState<RangeKey>('3m');
  const [history, setHistory] = useState<FundHistoryPoint[]>(() => historyCache.get(fundCode) ?? []);
  const [loading, setLoading] = useState(!historyCache.get(fundCode)?.length);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cached = historyCache.get(fundCode);
    if (cached && cached.length > 0) {
      setHistory(cached);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    fetchFundHistorySeries(fundCode)
      .then((data) => {
        if (cancelled) return;
        if (data.length > 0) {
          historyCache.set(fundCode, data);
        }
        setHistory(data);
        setError(data.length > 0 ? null : '暂无历史净值');
      })
      .catch(() => {
        if (!cancelled) setError('历史净值加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fundCode]);

  const selectedRange = RANGES.find((item) => item.key === range) ?? RANGES[2];
  const visible = useMemo(() => {
    if (range === 'ytd') return selectYearToDate(history);
    return selectRange(history, selectedRange.days);
  }, [history, range, selectedRange.days]);

  const metrics = useMemo(() => {
    if (visible.length < 2) return null;
    const first = visible[0];
    const last = visible[visible.length - 1];
    const returnPct = first.nav > 0 ? ((last.nav - first.nav) / first.nav) * 100 : 0;
    const high = Math.max(...visible.map((point) => point.nav));
    const low = Math.min(...visible.map((point) => point.nav));
    return {
      returnPct,
      drawdown: maxDrawdown(visible),
      high,
      low,
      first,
      last,
    };
  }, [visible]);

  const chart = makeChart(visible);
  const xTicks = makeXTicks(visible, range, chart.xStart, chart.xEnd);
  const activeIndex = selectedIndex !== null && selectedIndex < visible.length ? selectedIndex : null;
  const activePoint = activeIndex !== null ? visible[activeIndex] : null;
  const activePosition = activeIndex !== null ? chart.pointPositions[activeIndex] : null;
  const activeReturn = activePoint && visible[0]?.nav
    ? ((activePoint.nav - visible[0].nav) / visible[0].nav) * 100
    : 0;
  const tooltipX = activePosition ? Math.min(Math.max(activePosition.x + 10, 64), 492) : 0;
  const tooltipY = activePosition ? Math.min(Math.max(activePosition.y - 58, 8), 132) : 0;
  const up = (metrics?.returnPct ?? 0) >= 0;

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (visible.length === 0) return;
    const x = pointerSvgX(event);
    const ratio = (x - chart.xStart) / (chart.xEnd - chart.xStart);
    const index = Math.round(Math.min(Math.max(ratio, 0), 1) * (visible.length - 1));
    setSelectedIndex(index);
  };

  return (
    <div className={styles.container} onClick={(event) => event.stopPropagation()}>
      <div className={styles.toolbar}>
        <div className={styles.rangeGroup} aria-label="历史净值区间">
          {RANGES.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`${styles.rangeButton} ${range === item.key ? styles.rangeButtonActive : ''}`}
              onClick={() => setRange(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className={styles.state}>历史净值加载中...</div>}
      {!loading && error && <div className={styles.state}>{error}</div>}
      {!loading && !error && metrics && (
        <>
          <div className={styles.metrics}>
            <div>
              <span>区间涨跌</span>
              <strong className={up ? styles.up : styles.down}>
                {up ? '+' : ''}{metrics.returnPct.toFixed(2)}%
              </strong>
            </div>
            <div>
              <span>最大回撤</span>
              <strong className={styles.down}>{metrics.drawdown.toFixed(2)}%</strong>
            </div>
            <div>
              <span>最新净值</span>
              <strong>{metrics.last.nav.toFixed(4)}</strong>
            </div>
            <div>
              <span>高/低</span>
              <strong>{metrics.high.toFixed(4)} / {metrics.low.toFixed(4)}</strong>
            </div>
          </div>

          <div className={styles.chartWrap}>
            <svg
              className={styles.chart}
              viewBox="0 0 640 206"
              role="img"
              aria-label="官方历史单位净值走势"
              onPointerMove={handlePointerMove}
              onPointerDown={handlePointerMove}
              onPointerLeave={() => setSelectedIndex(null)}
            >
              {chart.yTicks.map((tick) => (
                <g key={tick.y}>
                  <text className={styles.yLabel} x="4" y={tick.y + 4}>{tick.value.toFixed(4)}</text>
                  <line className={styles.gridLine} x1={chart.xStart} y1={tick.y} x2={chart.xEnd} y2={tick.y} />
                </g>
              ))}
              <path className={`${styles.line} ${up ? styles.lineUp : styles.lineDown}`} d={chart.path} />
              {activePoint && activePosition && (
                <g>
                  <line className={styles.crosshair} x1={activePosition.x} y1="14" x2={activePosition.x} y2="166" />
                  <line className={styles.crosshair} x1={chart.xStart} y1={activePosition.y} x2={chart.xEnd} y2={activePosition.y} />
                  <circle className={styles.focusPoint} cx={activePosition.x} cy={activePosition.y} r="4" />
                  <g transform={`translate(${tooltipX}, ${tooltipY})`}>
                    <rect className={styles.tooltipBox} width="136" height="50" rx="6" />
                    <text className={styles.tooltipText} x="8" y="16">{activePoint.date}</text>
                    <text className={styles.tooltipText} x="8" y="31">净值 {activePoint.nav.toFixed(4)}</text>
                    <text className={activeReturn >= 0 ? styles.tooltipUp : styles.tooltipDown} x="8" y="46">
                      区间 {activeReturn >= 0 ? '+' : ''}{activeReturn.toFixed(2)}%
                    </text>
                  </g>
                </g>
              )}
              {xTicks.map((tick) => (
                <g key={`${tick.label}-${tick.x}`}>
                  <line className={styles.axisTick} x1={tick.x} y1="170" x2={tick.x} y2="174" />
                  <text className={styles.xLabel} x={tick.x} y="198" textAnchor={tick.anchor}>
                    {tick.label}
                  </text>
                </g>
              ))}
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
