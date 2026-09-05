import { useEffect, useMemo, useState } from 'react';
import { useFundHistory } from '../hooks/useFundHistory';
import type { FundHistoryPoint } from '../types';
import styles from './FundNavTable.module.css';

interface Props {
  fundCode: string;
}

const PAGE_SIZE = 10;
const TARGET_SIZE = 120;

function cutoffDate(latestDate: string, days: number): string {
  const date = new Date(`${latestDate}T12:00:00+08:00`);
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function formatDate(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date;
  return `${match[1]}/${match[2]}/${match[3]}`;
}

function latestThreeMonths(points: FundHistoryPoint[]): FundHistoryPoint[] {
  if (points.length === 0) return [];
  const latest = points[points.length - 1];
  const cutoff = cutoffDate(latest.date, 90);
  return points.filter((point) => point.date >= cutoff);
}

export default function FundNavTable({ fundCode }: Props) {
  const { history, loading, error } = useFundHistory(fundCode, TARGET_SIZE);
  const [page, setPage] = useState(0);

  const rows = useMemo(() => (
    latestThreeMonths(history).slice().reverse()
  ), [history]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageRows = rows.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [fundCode]);

  useEffect(() => {
    if (page > totalPages - 1) setPage(totalPages - 1);
  }, [page, totalPages]);

  return (
    <div className={styles.container} onClick={(event) => event.stopPropagation()}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>每日净值</div>
          <div className={styles.subtitle}>近3个月官方单位净值</div>
        </div>
        {!loading && rows.length > 0 && (
          <div className={styles.count}>共 {rows.length} 条</div>
        )}
      </div>

      {loading && <div className={styles.state}>净值加载中...</div>}
      {!loading && error && <div className={styles.stateError} role="alert">{error}</div>}
      {!loading && !error && rows.length === 0 && <div className={styles.state}>暂无历史净值</div>}
      {!loading && rows.length > 0 && (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>单位净值</th>
                  <th>日涨跌</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const up = (row.changePercent ?? 0) >= 0;
                  return (
                    <tr key={row.date}>
                      <td>{formatDate(row.date)}</td>
                      <td>{row.nav.toFixed(4)}</td>
                      <td className={up ? styles.up : styles.down}>
                        {row.changePercent == null ? '--' : `${up ? '+' : ''}${row.changePercent.toFixed(2)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className={styles.pagination}>
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
            >
              上一页
            </button>
            <span>{currentPage + 1} / {totalPages}</span>
            <button
              type="button"
              disabled={currentPage >= totalPages - 1}
              onClick={() => setPage((value) => Math.min(totalPages - 1, value + 1))}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </div>
  );
}
