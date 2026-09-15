import { useMemo, useState } from 'react';
import { formatReturn } from '../historyMetrics';
import type { HistoryComparison, LongHistoryAsset } from '../longHistory';
import styles from './LongHistoryPage.module.css';
import rankingStyles from './RankingPage.module.css';

interface Props {
  comparison?: HistoryComparison;
  assets: LongHistoryAsset[];
  onSelect: (id: string) => void;
}

export default function HistoryComparisonTable({ comparison, assets, onSelect }: Props) {
  const [sort, setSort] = useState<{ key: 'change' | 'cagr'; descending: boolean }>({ key: 'change', descending: true });
  const rows = useMemo(() => (comparison?.rows ?? []).filter(row => assets.some(asset => asset.id === row.id)).sort((a, b) => {
    const left = a[sort.key];
    const right = b[sort.key];
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    return (sort.descending ? -1 : 1) * (left - right);
  }), [comparison, assets, sort]);
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const sources = [...new Set(assets.flatMap(asset => asset.sources))];
  const tone = (value: number | null) => value == null ? styles.missing : value >= 0 ? styles.up : styles.down;

  return <>
    <div className={styles.comparisonMeta} aria-label="涨幅统计区间">
      <span>{comparison?.startPeriod ?? '--'} 至 {comparison?.endPeriod ?? '--'}</span>
    </div>
    <div className={styles.tableScroll}>
      <table className={styles.comparisonTable} aria-label="区间涨幅">
        <colgroup><col className={styles.comparisonRankCol} /><col className={styles.comparisonNameCol} /><col /><col /></colgroup>
        <thead><tr>
          <th scope="col">排名</th><th scope="col">名称</th>
          {([['change', '涨幅'], ['cagr', '年化涨幅']] as const).map(([key, label]) => <th key={key} scope="col"
            aria-sort={sort.key === key ? sort.descending ? 'descending' : 'ascending' : 'none'}>
            <button type="button" className={styles.sortButton} onClick={() => setSort({ key, descending: sort.key === key ? !sort.descending : true })}>
              {label}<span aria-hidden="true">{sort.key === key ? sort.descending ? '↓' : '↑' : ''}</span>
            </button>
          </th>)}
        </tr></thead>
        <tbody>{rows.map((row, index) => <tr key={row.id}>
          <td>{row[sort.key] == null ? <span className={styles.missing}>--</span>
            : <span className={`${rankingStyles.rank} ${[rankingStyles.gold, rankingStyles.silver, rankingStyles.bronze][index] ?? ''}`}>#{index + 1}</span>}</td>
          <th scope="row"><button type="button" className={styles.assetLink} onClick={() => onSelect(row.id)}>{byId.get(row.id)?.name ?? row.id}</button></th>
          <td className={tone(row.change)}>{formatReturn(row.change)}{row.reason && <small>{row.reason}</small>}</td>
          <td className={tone(row.cagr)} title={row.reason || row.cagrReason}>{formatReturn(row.cagr)}{!row.reason && row.cagrReason && <small>{row.cagrReason}</small>}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {!rows.length && <p className={styles.message}>暂无同区间数据</p>}
    <p className={styles.note}>* 按完整自然年的区间累计涨幅排名，以起始年前一年末为基准，不含未结束的当年。年化按复合增长计算；缺少起止数据时不排名，不含股息、汇率及持有成本，商品连续期货包含换月影响。</p>
    <p className={styles.sourceNote}>数据来源：{sources.join('、') || '待补全'}。</p>
  </>;
}
