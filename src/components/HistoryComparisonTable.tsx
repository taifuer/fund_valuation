import { useId, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { formatReturn } from '../historyMetrics';
import type { HistoryComparison, LongHistoryAsset, PeriodPerformance } from '../longHistory';
import { formatHistoryNumber, formatMonthlyDrawdown, monthlyDrawdownValue, monthlyDrawdownTitle, MONTHLY_DRAWDOWN_NOTE } from '../longHistory';
import styles from './LongHistoryPage.module.css';
import rankingStyles from './RankingPage.module.css';

interface Props {
  comparison?: HistoryComparison;
  assets: LongHistoryAsset[];
  onSelect: (id: string) => void;
}

function closingValue(value: number | null | undefined) {
  return formatHistoryNumber(value != null && Number.isFinite(value) ? value : null);
}

type SortKey = 'change' | 'cagr' | 'monthlyDrawdown';

function sortValue(row: PeriodPerformance, key: SortKey) {
  const value = key === 'monthlyDrawdown' ? monthlyDrawdownValue(row) : row[key];
  return value == null || !Number.isFinite(value) ? null : key === 'monthlyDrawdown' ? Math.abs(value) : value;
}

export default function HistoryComparisonTable({ comparison, assets, onSelect }: Props) {
  const noteId = useId();
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'change', descending: true });
  const rows = useMemo(() => (comparison?.rows ?? []).filter(row => assets.some(asset => asset.id === row.id)).sort((a, b) => {
    const left = sortValue(a, sort.key);
    const right = sortValue(b, sort.key);
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    return (sort.descending ? -1 : 1) * (left - right);
  }), [comparison, assets, sort]);
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const sources = [...new Set(assets.flatMap(asset => asset.sources))];
  const independent = comparison?.independentPeriods;
  const tone = (value: number | null) => value == null ? styles.missing : value >= 0 ? styles.up : styles.down;
  const valuesWidth = Math.max(160, ...rows.map(row => {
    const length = closingValue(row.startClose).length + closingValue(row.endClose).length;
    const unit = byId.get(row.id)?.unit;
    return length * 8 + 44 + (unit === 'USD' ? 8 : unit ? unit.length * 13 + 4 : 0);
  }));

  return <>
    <div className={styles.tableScroll} role="region" aria-label="涨幅表格" tabIndex={0}>
      <table className={styles.comparisonTable} aria-label="区间涨幅"
        style={{ '--comparison-values-width': `${valuesWidth}px` } as CSSProperties}>
        <colgroup><col className={styles.comparisonRankCol} /><col className={styles.comparisonNameCol} /><col className={styles.comparisonChangeCol} /><col className={styles.comparisonCagrCol} /><col className={styles.comparisonDrawdownCol} /><col className={styles.comparisonValuesCol} /><col className={styles.comparisonPeriodCol} /></colgroup>
        <thead><tr>
          <th scope="col">排名</th><th scope="col">名称</th>
          {([['change', '涨幅'], ['cagr', '年化涨幅'], ['monthlyDrawdown', '回撤']] as const).map(([key, label]) => <th key={key} scope="col"
            aria-sort={sort.key === key ? sort.descending ? 'descending' : 'ascending' : 'none'}>
            <button type="button" className={styles.sortButton} aria-describedby={`${noteId}-${key}`} title={key === 'monthlyDrawdown' ? `${MONTHLY_DRAWDOWN_NOTE}按跌幅大小排序。` : undefined}
              onClick={() => setSort({ key, descending: sort.key === key ? !sort.descending : true })}>
              {label}<sup className={styles.noteMark} aria-hidden="true">*</sup><span aria-hidden="true">{sort.key === key ? sort.descending ? '↓' : '↑' : ''}</span>
            </button>
          </th>)}
          <th scope="col">起止值</th><th scope="col">区间</th>
        </tr></thead>
        <tbody>{rows.map((row, index) => {
          const asset = byId.get(row.id);
          const unit = asset?.unit;
          return <tr key={row.id}>
          <td>{sortValue(row, sort.key) == null ? <span className={styles.missing}>--</span>
            : <span className={`${rankingStyles.rank} ${[rankingStyles.gold, rankingStyles.silver, rankingStyles.bronze][index] ?? ''}`}>#{index + 1}</span>}</td>
          <th scope="row"><button type="button" className={styles.assetLink} onClick={() => onSelect(row.id)}>{asset?.name ?? row.id}</button></th>
          <td className={tone(row.change)}>{formatReturn(row.change)}{row.reason && <small>{row.reason}</small>}</td>
          <td className={tone(row.cagr)} title={row.reason || row.cagrReason}>{formatReturn(row.cagr)}{!row.reason && row.cagrReason && <small>{row.cagrReason}</small>}</td>
          <td className={styles.drawdown} title={monthlyDrawdownTitle(row)}>{formatMonthlyDrawdown(row)}{row.monthlyDrawdownReason && !row.reason && <small>{row.monthlyDrawdownReason}</small>}</td>
          <td className={styles.comparisonValues}
            title={`基准：${row.startPeriod ?? '--'}；期末：${row.endPeriod ?? '--'}${unit ? `；单位：${unit === 'USD' ? '美元 USD' : unit}` : ''}`}>
            <span className={styles.valuesPair}>
              <span>{unit === 'USD' ? '$' : ''}{closingValue(row.startClose)}</span>
              <span aria-hidden="true">{' → '}</span>
              <span>{closingValue(row.endClose)}{unit && unit !== 'USD' ? ` ${unit}` : ''}</span>
            </span>
          </td>
          <td className={styles.comparisonPeriod}>{independent
            ? row.startPeriod && row.endPeriod ? `${row.startPeriod} 至 ${row.endPeriod}` : '--'
            : `${comparison?.startPeriod ?? '--'} 至 ${comparison?.endPeriod ?? '--'}`}</td>
        </tr>;
        })}</tbody>
      </table>
    </div>
    {!rows.length && <p className={styles.message}>暂无同区间数据</p>}
    <div className={styles.notes}>
      <p id={`${noteId}-change`}>* 涨幅：{independent ? '全部按各自最早可用月末至最新完整月份计算；起点和跨度不同，不能视为同期间的表现对比。' : '按完整自然年的区间累计涨幅计算，以起始年前一年末为基准，不含未结束的当年。'}</p>
      <p id={`${noteId}-cagr`}>* 年化涨幅：按区间复合增长计算，不是年度涨幅的平均值；不足一年不计算。</p>
      <p id={`${noteId}-monthlyDrawdown`}>* 回撤：{MONTHLY_DRAWDOWN_NOTE}缺月或数据不足时留空，按跌幅大小排序。</p>
      <p>所选排序指标缺失时不排名。不含股息、汇率及持有成本，商品连续期货包含换月影响。</p>
    </div>
    <p className={styles.sourceNote}>数据来源：{sources.join('、') || '待补全'}。</p>
  </>;
}
