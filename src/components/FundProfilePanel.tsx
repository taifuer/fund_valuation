import { useEffect, useState } from 'react';
import { fetchFundProfiles, fetchFundPurchaseStatuses, fetchFundReturnSummaries } from '../api';
import type { Fund, FundPurchaseData, FundRangeReturn, FundReturnRangeKey, FundReturnSummary } from '../types';
import styles from './FundProfilePanel.module.css';

interface Props {
  fundCode: string;
  fallbackProfile?: Fund['profile'];
}

const RETURN_RANGES: FundReturnRangeKey[] = ['1w', '1m', '3m', '6m', '1y', '3y', 'ytd'];

function formatChineseDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日` : value || '--';
}

function formatPurchaseAmount(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return '--';
  if (value >= 10_000_000_000) return '不限';
  if (value >= 10_000) return `${Number((value / 10_000).toFixed(2))}万元`;
  return `${Number(value.toFixed(2))}元`;
}

function purchaseTone(status: string): string {
  if (status.includes('暂停')) return styles.stopped;
  if (status.includes('限') || status.includes('封闭')) return styles.limited;
  return styles.open;
}

function ReturnItems({ summary }: { summary: FundReturnSummary | null }) {
  const items = RETURN_RANGES
    .map((key) => summary?.ranges[key])
    .filter((item): item is FundRangeReturn => item != null);
  if (items.length === 0) return <span className={styles.empty}>暂无区间收益</span>;
  return (
    <div className={styles.returns}>
      {items.map((item) => (
        <span key={item.key} className={styles.returnItem}>
          <em>{item.label}</em>
          <strong className={item.returnPercent >= 0 ? styles.returnUp : styles.returnDown}>
            {item.returnPercent >= 0 ? '+' : ''}{item.returnPercent.toFixed(2)}%
          </strong>
        </span>
      ))}
    </div>
  );
}

export default function FundProfilePanel({ fundCode, fallbackProfile }: Props) {
  const [profile, setProfile] = useState<Fund['profile']>(fallbackProfile);
  const [purchase, setPurchase] = useState<FundPurchaseData | null>(null);
  const [returns, setReturns] = useState<FundReturnSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchFundProfiles([fundCode]),
      fetchFundPurchaseStatuses([fundCode]),
      fetchFundReturnSummaries([fundCode]),
    ]).then(([profiles, purchases, summaries]) => {
      if (cancelled) return;
      setProfile(profiles.get(fundCode) ?? fallbackProfile);
      setPurchase(purchases.get(fundCode) ?? null);
      setReturns(summaries.get(fundCode) ?? null);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [fallbackProfile, fundCode]);

  if (loading) return <div className={styles.state}>基金资料加载中...</div>;

  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <h4>基本资料</h4>
        {profile ? (
          <dl className={styles.details}>
            <div><dt>成立日期</dt><dd>{formatChineseDate(profile.inceptionDate)}</dd></div>
            <div><dt>基金规模</dt><dd>{profile.assetScale || '--'}<small>截至 {formatChineseDate(profile.scaleDate)}</small></dd></div>
            <div><dt>管理费</dt><dd>{profile.managementFee || '--'}</dd></div>
            <div><dt>托管费</dt><dd>{profile.custodianFee || '--'}</dd></div>
            <div><dt>销售服务费</dt><dd>{profile.salesServiceFee || '--'}</dd></div>
          </dl>
        ) : <span className={styles.empty}>暂无基本资料</span>}
      </section>

      <section className={styles.section}>
        <h4>申购信息 <small>渠道参考</small></h4>
        {purchase ? (
          <dl className={styles.details}>
            <div><dt>申购状态</dt><dd><span className={`${styles.status} ${purchaseTone(purchase.purchaseStatus)}`}>{purchase.purchaseStatus}</span></dd></div>
            <div><dt>单日限额</dt><dd>{formatPurchaseAmount(purchase.dailyLimit)}</dd></div>
            <div><dt>最低起购</dt><dd>{formatPurchaseAmount(purchase.minPurchase)}</dd></div>
            <div><dt>赎回状态</dt><dd>{purchase.redeemStatus || '--'}</dd></div>
          </dl>
        ) : <span className={styles.empty}>暂无申购信息</span>}
        {purchase?.fetchedAt ? <p className={styles.note}>获取于 {new Date(purchase.fetchedAt).toLocaleString('zh-CN', { hour12: false })}，实际状态及限额以销售渠道为准。</p> : null}
      </section>

      <section className={styles.section}>
        <h4>官方净值区间收益 <small>{returns?.asOf ? `截至 ${returns.asOf}` : ''}</small></h4>
        <ReturnItems summary={returns} />
      </section>
    </div>
  );
}
