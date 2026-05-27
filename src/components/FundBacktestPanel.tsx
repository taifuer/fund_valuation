import { useEffect, useState } from 'react';
import { fetchFundBacktest } from '../api';
import type { FundBacktestSummary } from '../types';
import styles from './FundBacktestPanel.module.css';

interface Props {
  fundCode: string;
}

function formatMetric(value: number | null, suffix = ''): string {
  return value == null ? '--' : `${value.toFixed(2)}${suffix}`;
}

function modelLabel(model: FundBacktestSummary['recommendedModel']): string {
  if (model === 'linear') return '线性拟合';
  if (model === 'normalizedLinear') return '归一化拟合';
  return '原始估算';
}

export default function FundBacktestPanel({ fundCode }: Props) {
  const [data, setData] = useState<FundBacktestSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load(refresh = false) {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    const result = await fetchFundBacktest(fundCode, 90, refresh);
    setData(result);
    setLoading(false);
    setRefreshing(false);
  }

  useEffect(() => {
    void load(false);
  }, [fundCode]);

  if (loading) {
    return <div className={styles.empty}>回测数据加载中...</div>;
  }

  if (!data) {
    return (
      <div className={styles.empty}>
        <span>暂无回测数据</span>
        <button type="button" className={styles.refreshButton} onClick={() => load(true)} disabled={refreshing}>
          {refreshing ? '刷新中' : '刷新回测'}
        </button>
      </div>
    );
  }

  const recentPoints = [...data.points].slice(-8).reverse();

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>估值回测</div>
          <div className={styles.range}>
            {data.startDate} 至 {data.endDate} · 训练 {data.trainSampleCount} / 验证 {data.validationSampleCount}
          </div>
        </div>
        <button type="button" className={styles.refreshButton} onClick={() => load(true)} disabled={refreshing}>
          {refreshing ? '刷新中' : '刷新回测'}
        </button>
      </div>

      <div className={styles.metrics}>
        <div className={styles.metricBox}>
          <span>建议模型</span>
          <strong>{modelLabel(data.recommendedModel)}</strong>
        </div>
        <div className={styles.metricBox}>
          <span>验证 MAE</span>
          <strong>{formatMetric(data.validation.selected.mae, '%')}</strong>
        </div>
        <div className={styles.metricBox}>
          <span>验证方向</span>
          <strong>{formatMetric(data.validation.selected.directionAccuracy, '%')}</strong>
        </div>
        <div className={styles.metricBox}>
          <span>十大权重</span>
          <strong>{data.topHoldingWeight.toFixed(1)}%</strong>
        </div>
      </div>

      <div className={styles.compareGrid}>
        <span>验证集 MAE</span>
        <strong>原始 {formatMetric(data.validation.raw.mae, '%')}</strong>
        <strong>线性 {formatMetric(data.validation.linear.mae, '%')}</strong>
        <strong>归一化 {formatMetric(data.validation.normalizedLinear.mae, '%')}</strong>
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>日期</th>
            <th>估算</th>
            <th>归一化</th>
            <th>拟合</th>
            <th>实际</th>
            <th>误差</th>
          </tr>
        </thead>
        <tbody>
          {recentPoints.map((point) => (
            <tr key={point.date}>
              <td>{point.date}</td>
              <td>{point.predictedChange >= 0 ? '+' : ''}{point.predictedChange.toFixed(2)}%</td>
              <td>{point.normalizedChange >= 0 ? '+' : ''}{point.normalizedChange.toFixed(2)}%</td>
              <td>{point.fittedChange >= 0 ? '+' : ''}{point.fittedChange.toFixed(2)}%</td>
              <td>{point.actualChange >= 0 ? '+' : ''}{point.actualChange.toFixed(2)}%</td>
              <td>{point.fittedError >= 0 ? '+' : ''}{point.fittedError.toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={styles.note}>
        当前回测基于最新前十大持仓，暂未纳入历史汇率、历史季度持仓切换和未披露持仓。
      </div>
    </div>
  );
}
