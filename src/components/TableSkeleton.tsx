import styles from './RankingPage.module.css';

export default function TableSkeleton({ rows, columns }: { rows: number; columns: number }) {
  return <>{Array.from({ length: rows }, (_, row) => (
    <tr key={row} aria-hidden="true">
      {Array.from({ length: columns }, (_, column) => (
        <td key={column}><span className={styles.skeletonCell} /></td>
      ))}
    </tr>
  ))}</>;
}
