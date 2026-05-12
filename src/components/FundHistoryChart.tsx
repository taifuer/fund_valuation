import { useEffect, useMemo, useState } from 'react';
import { fetchFundHistorySeries } from '../api';
import type { FundHistoryPoint } from '../types';
import styles from './FundHistoryChart.module.css';

interface Props {
  fundCode: string;
}

type RangeKey = '1w' | '1m' | '3m' | '6m' | '1y' | '3y' | '5y' | 'all';

const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: '1w', label: '1周', days: 7 },
  { key: '1m', label: '1月', days: 30 },
  { key: '3m', label: '3月', days: 90 },
  { key: '6m', label: '半年', days: 183 },
  { key: '1y', label: '1年', days: 365 },
  { key: '3y', label: '3年', days: 365 * 3 },
  { key: '5y', label: '5年', days: 365 * 5 },
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
  if (range === '1w' || range === '1m' || range === '3m' || range === '6m') {
    return `${month}/${day}`;
  }
  if (range === '1y') {
    return `${year}/${month}`;
  }
  return year;
}

function cutoffDate(latestDate: string, days: number): string {
  const date = new Date(`${latestDate}T12:00:00+08:00`);
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
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
    return { path: '', min: 0, mid: 0, max: 0 };
  }
  const width = 640;
  const height = 206;
  const padLeft = 48;
  const padRight = 20;
  const padY = 14;
  const plotHeight = 180;
  const min = Math.min(...points.map((point) => point.nav));
  const max = Math.max(...points.map((point) => point.nav));
  const mid = (min + max) / 2;
  const span = max - min || 1;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = plotHeight - padY * 2;

  const path = points
    .map((point, index) => {
      const x = padLeft + (points.length === 1 ? innerWidth : (index / (points.length - 1)) * innerWidth);
      const y = padY + ((max - point.nav) / span) * innerHeight;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return {
    path,
    min,
    mid,
    max,
    xStart: padLeft,
    xMiddle: padLeft + innerWidth / 2,
    xEnd: padLeft + innerWidth,
  };
}

export default function FundHistoryChart({ fundCode }: Props) {
  const [range, setRange] = useState<RangeKey>('3m');
  const [history, setHistory] = useState<FundHistoryPoint[]>(() => historyCache.get(fundCode) ?? []);
  const [loading, setLoading] = useState(!historyCache.get(fundCode)?.length);
  const [error, setError] = useState<string | null>(null);

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
    if (history.length === 0) return [];
    if (selectedRange.days === null) return history;
    const latest = history[history.length - 1];
    const cutoff = cutoffDate(latest.date, selectedRange.days);
    const sliced = history.filter((point) => point.date >= cutoff);
    return sliced.length >= 2 ? sliced : history.slice(-Math.min(history.length, 2));
  }, [history, selectedRange.days]);

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
  const middlePoint = visible[Math.floor((visible.length - 1) / 2)];
  const up = (metrics?.returnPct ?? 0) >= 0;

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
            <svg className={styles.chart} viewBox="0 0 640 206" role="img" aria-label="官方历史单位净值走势">
              <text className={styles.yLabel} x="4" y="18">{chart.max.toFixed(4)}</text>
              <text className={styles.yLabel} x="4" y="94">{chart.mid.toFixed(4)}</text>
              <text className={styles.yLabel} x="4" y="168">{chart.min.toFixed(4)}</text>
              <line className={styles.gridLine} x1={chart.xStart} y1="14" x2={chart.xEnd} y2="14" />
              <line className={styles.gridLine} x1={chart.xStart} y1="90" x2={chart.xEnd} y2="90" />
              <line className={styles.gridLine} x1={chart.xStart} y1="166" x2={chart.xEnd} y2="166" />
              <path className={`${styles.line} ${up ? styles.lineUp : styles.lineDown}`} d={chart.path} />
              <text className={styles.xLabel} x={chart.xStart} y="198" textAnchor="start">
                {formatAxisDate(metrics.first.date, range)}
              </text>
              <text className={styles.xLabel} x={chart.xMiddle} y="198" textAnchor="middle">
                {middlePoint ? formatAxisDate(middlePoint.date, range) : ''}
              </text>
              <text className={styles.xLabel} x={chart.xEnd} y="198" textAnchor="end">
                {formatAxisDate(metrics.last.date, range)}
              </text>
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
