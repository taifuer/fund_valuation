import { useEffect, useMemo, useState } from 'react';
import { fetchMarketHistory } from '../api';
import type { IndexConfig, MarketHistoryPoint, QuoteData } from '../types';
import styles from './MarketHistoryModal.module.css';

interface Props {
  item: IndexConfig;
  currentQuote?: QuoteData;
  onClose: () => void;
}

type RangeKey = '1d' | '1w' | '1m' | '3m' | '6m' | '1y' | '3y' | '5y' | 'all';
type TextAnchor = 'start' | 'middle' | 'end';

const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: '1d', label: '1日', days: 1 },
  { key: '1w', label: '1周', days: 7 },
  { key: '1m', label: '1月', days: 30 },
  { key: '3m', label: '3月', days: 90 },
  { key: '6m', label: '半年', days: 183 },
  { key: '1y', label: '1年', days: 365 },
  { key: '3y', label: '3年', days: 365 * 3 },
  { key: '5y', label: '5年', days: 365 * 5 },
  { key: 'all', label: '全部', days: null },
];

const historyCache = new Map<string, MarketHistoryPoint[]>();

function todayDate(): string {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return bj.toISOString().slice(0, 10);
}

function cutoffDate(latestDate: string, days: number): string {
  const date = new Date(`${latestDate}T12:00:00+08:00`);
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function selectRange(points: MarketHistoryPoint[], days: number | null): MarketHistoryPoint[] {
  if (points.length <= 2 || days === null) return points;
  const latest = points[points.length - 1];
  const cutoff = cutoffDate(latest.date, days);
  const firstAfterCutoff = points.findIndex((point) => point.date >= cutoff);
  if (firstAfterCutoff <= 0) return points;
  const startIndex = points[firstAfterCutoff].date === cutoff ? firstAfterCutoff : firstAfterCutoff - 1;
  const sliced = points.slice(startIndex);
  return sliced.length >= 2 ? sliced : points.slice(-2);
}

function selectOneDay(points: MarketHistoryPoint[], currentQuote?: QuoteData): MarketHistoryPoint[] {
  if (!currentQuote || currentQuote.price <= 0 || currentQuote.previousClose <= 0) {
    return points.slice(-Math.min(points.length, 2));
  }

  const quoteDate = currentQuote.dateReliable && currentQuote.time ? currentQuote.time : todayDate();
  const previousPoint =
    [...points].reverse().find((point) => point.date < quoteDate) ??
    points[points.length - 2];
  const basePoint: MarketHistoryPoint = previousPoint
    ? { date: previousPoint.date, close: currentQuote.previousClose }
    : { date: '前收', close: currentQuote.previousClose };

  return [
    basePoint,
    {
      date: quoteDate,
      close: currentQuote.price,
    },
  ];
}

function tickCount(range: RangeKey): number {
  if (range === '1d') return 2;
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

function formatAxisDate(date: string, range: RangeKey): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date;
  const [, year, month, day] = match;
  if (range === '1d' || range === '1w' || range === '1m' || range === '3m' || range === '6m') {
    return `${month}/${day}`;
  }
  if (range === '1y') {
    return `${year}/${month}`;
  }
  return year;
}

function maxDrawdown(points: MarketHistoryPoint[]): number {
  let peak = points[0]?.close ?? 0;
  let worst = 0;
  for (const point of points) {
    peak = Math.max(peak, point.close);
    if (peak > 0) {
      worst = Math.min(worst, ((point.close - peak) / peak) * 100);
    }
  }
  return worst;
}

function makeChart(points: MarketHistoryPoint[]) {
  if (points.length === 0) {
    return { path: '', min: 0, max: 0, xStart: 56, xEnd: 584, yTicks: [], pointPositions: [] };
  }

  const width = 640;
  const padLeft = 56;
  const padRight = 56;
  const padY = 14;
  const plotHeight = 190;
  const min = Math.min(...points.map((point) => point.close));
  const max = Math.max(...points.map((point) => point.close));
  const span = max - min || 1;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = plotHeight - padY * 2;

  const pointPositions = points.map((point, index) => {
      const x = padLeft + (points.length === 1 ? innerWidth : (index / (points.length - 1)) * innerWidth);
      const y = padY + ((max - point.close) / span) * innerHeight;
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

function formatValue(value: number): string {
  if (value >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function makeXTicks(points: MarketHistoryPoint[], range: RangeKey, xStart: number, xEnd: number) {
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

export default function MarketHistoryModal({ item, currentQuote, onClose }: Props) {
  const [range, setRange] = useState<RangeKey>('3m');
  const cacheKey = item.history ? `${item.history.source}:${item.history.symbol}` : item.sinaSymbol;
  const [history, setHistory] = useState<MarketHistoryPoint[]>(() => historyCache.get(cacheKey) ?? []);
  const [loading, setLoading] = useState(!historyCache.get(cacheKey)?.length);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const cached = historyCache.get(cacheKey);
    if (cached && cached.length > 0) {
      setHistory(cached);
      setLoading(false);
      setError(null);
      return;
    }
    if (!item.history) {
      setHistory([]);
      setLoading(false);
      setError('暂无历史行情');
      return;
    }

    setLoading(true);
    setError(null);
    fetchMarketHistory(item.history)
      .then((data) => {
        if (cancelled) return;
        if (data.length > 0) {
          historyCache.set(cacheKey, data);
        }
        setHistory(data);
        setError(data.length > 0 ? null : '暂无历史行情');
      })
      .catch(() => {
        if (!cancelled) setError('历史行情加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, item.history]);

  const selectedRange = RANGES.find((rangeItem) => rangeItem.key === range) ?? RANGES[2];
  const visible = useMemo(() => {
    if (range === '1d') return selectOneDay(history, currentQuote);
    return selectRange(history, selectedRange.days);
  }, [currentQuote, history, range, selectedRange.days]);

  const metrics = useMemo(() => {
    if (visible.length < 2) return null;
    const first = visible[0];
    const last = visible[visible.length - 1];
    const returnPct = first.close > 0 ? ((last.close - first.close) / first.close) * 100 : 0;
    const high = Math.max(...visible.map((point) => point.close));
    const low = Math.min(...visible.map((point) => point.close));
    return {
      first,
      last,
      returnPct,
      drawdown: maxDrawdown(visible),
      high,
      low,
    };
  }, [visible]);

  const chart = makeChart(visible);
  const xTicks = makeXTicks(visible, range, chart.xStart, chart.xEnd);
  const activeIndex = selectedIndex !== null && selectedIndex < visible.length ? selectedIndex : null;
  const activePoint = activeIndex !== null ? visible[activeIndex] : null;
  const activePosition = activeIndex !== null ? chart.pointPositions[activeIndex] : null;
  const activeReturn = activePoint && visible[0]?.close
    ? ((activePoint.close - visible[0].close) / visible[0].close) * 100
    : 0;
  const tooltipX = activePosition ? Math.min(Math.max(activePosition.x + 10, 64), 492) : 0;
  const tooltipY = activePosition ? Math.min(Math.max(activePosition.y - 58, 8), 144) : 0;
  const up = (metrics?.returnPct ?? 0) >= 0;

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (visible.length === 0) return;
    const x = pointerSvgX(event);
    const ratio = (x - chart.xStart) / (chart.xEnd - chart.xStart);
    const index = Math.round(Math.min(Math.max(ratio, 0), 1) * (visible.length - 1));
    setSelectedIndex(index);
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={`${item.name}历史走势`} onClick={(event) => event.stopPropagation()}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>{item.name}</div>
            <div className={styles.subtitle}>{item.symbol}</div>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className={styles.rangeGroup} aria-label="历史行情区间">
          {RANGES.map((rangeItem) => (
            <button
              key={rangeItem.key}
              type="button"
              className={`${styles.rangeButton} ${range === rangeItem.key ? styles.rangeButtonActive : ''}`}
              onClick={() => setRange(rangeItem.key)}
            >
              {rangeItem.label}
            </button>
          ))}
        </div>

        {loading && <div className={styles.state}>历史行情加载中...</div>}
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
                <span>最新价格</span>
                <strong>{formatValue(metrics.last.close)}</strong>
              </div>
              <div>
                <span>高/低</span>
                <strong>{formatValue(metrics.high)} / {formatValue(metrics.low)}</strong>
              </div>
            </div>

            <div className={styles.chartWrap}>
              <svg
                className={styles.chart}
                viewBox="0 0 640 218"
                role="img"
                aria-label={`${item.name}历史走势`}
                onPointerMove={handlePointerMove}
                onPointerDown={handlePointerMove}
                onPointerLeave={() => setSelectedIndex(null)}
              >
                {chart.yTicks.map((tick) => (
                  <g key={tick.y}>
                    <text className={styles.yLabel} x="4" y={tick.y + 4}>{formatValue(tick.value)}</text>
                    <line className={styles.gridLine} x1={chart.xStart} y1={tick.y} x2={chart.xEnd} y2={tick.y} />
                  </g>
                ))}
                <path className={`${styles.line} ${up ? styles.lineUp : styles.lineDown}`} d={chart.path} />
                {activePoint && activePosition && (
                  <g>
                    <line className={styles.crosshair} x1={activePosition.x} y1="14" x2={activePosition.x} y2="176" />
                    <line className={styles.crosshair} x1={chart.xStart} y1={activePosition.y} x2={chart.xEnd} y2={activePosition.y} />
                    <circle className={styles.focusPoint} cx={activePosition.x} cy={activePosition.y} r="4" />
                    <g transform={`translate(${tooltipX}, ${tooltipY})`}>
                      <rect className={styles.tooltipBox} width="136" height="50" rx="6" />
                      <text className={styles.tooltipText} x="8" y="16">{activePoint.date}</text>
                      <text className={styles.tooltipText} x="8" y="31">价格 {formatValue(activePoint.close)}</text>
                      <text className={activeReturn >= 0 ? styles.tooltipUp : styles.tooltipDown} x="8" y="46">
                        区间 {activeReturn >= 0 ? '+' : ''}{activeReturn.toFixed(2)}%
                      </text>
                    </g>
                  </g>
                )}
                {xTicks.map((tick) => (
                  <g key={`${tick.label}-${tick.x}`}>
                    <line className={styles.axisTick} x1={tick.x} y1="180" x2={tick.x} y2="184" />
                    <text className={styles.xLabel} x={tick.x} y="210" textAnchor={tick.anchor}>
                      {tick.label}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
