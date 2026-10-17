import { useState, useEffect, type MouseEvent } from 'react';
import { restoredPagePath } from '../routing';
import type { FxRateData } from '../types';
import type { PageKey } from '../routing';
import type { SystemStatus } from '../types';
import Logo from './Logo';
import styles from './Header.module.css';

function formatTime() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const month = String(beijing.getUTCMonth() + 1).padStart(2, '0');
  const day = String(beijing.getUTCDate()).padStart(2, '0');
  const hour = String(beijing.getUTCHours()).padStart(2, '0');
  const minute = String(beijing.getUTCMinutes()).padStart(2, '0');
  const second = String(beijing.getUTCSeconds()).padStart(2, '0');
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = weekdays[beijing.getUTCDay()];
  return `${beijing.getUTCFullYear()}年${month}月${day}日 ${weekday} ${hour}:${minute}:${second}`;
}

interface Props {
  fxRates: Map<string, FxRateData>;
  activePage: PageKey;
  onPageChange: (page: PageKey) => void;
  systemStatus?: SystemStatus | null;
  showMarketMeta?: boolean;
}

const FX_ORDER = ['USD', 'EUR'];

function statusLabel(status: SystemStatus | null) {
  if (!status) return '服务状态检查中';
  if (status.status === 'offline') return '服务状态暂不可用';
  if (status.status === 'ok') {
    return status.holdingQuoteIssueCount
      ? `服务运行正常（${status.holdingQuoteIssueCount} 项持仓行情待更新）`
      : '服务运行正常';
  }
  const reasons = status.reasons ?? [];
  const labels = [
    reasons.includes('worker-stale') ? '后台刷新延迟' : '',
    reasons.includes('market-quotes') ? '市场行情待更新' : '',
    reasons.includes('holding-quotes') ? '持仓行情大面积延迟' : '',
    reasons.includes('status-stale') ? '状态检查待更新' : '',
  ].filter(Boolean);
  return labels.length ? labels.join('；') : `数据刷新存在延迟（${status.quoteIssueCount} 项）`;
}

export default function Header({
  fxRates,
  activePage,
  onPageChange,
  systemStatus = null,
  showMarketMeta = activePage === 'overview',
}: Props) {
  const [time, setTime] = useState(formatTime());
  const displayRates = FX_ORDER.map((currency) => fxRates.get(currency)).filter((rate): rate is FxRateData => rate != null);
  const freshnessLabel = statusLabel(systemStatus);

  useEffect(() => {
    if (!showMarketMeta) return;
    const timer = setInterval(() => setTime(formatTime()), 1000);
    return () => clearInterval(timer);
  }, [showMarketMeta]);

  function reloadToTop() {
    onPageChange('overview');
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function navigate(event: MouseEvent<HTMLAnchorElement>, page: PageKey) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (page === 'overview') reloadToTop();
    else onPageChange(page);
  }

  return (
    <>
      <header className={styles.header}>
        <div className={styles.inner}>
          <div className={styles.brand}>
            <Logo />
            <div>
              <h1 className={styles.title}>
                <a href="/" className={styles.titleButton} onClick={(event) => navigate(event, 'overview')}>
                  全球资产看板
                </a>
              </h1>
              <div className={styles.subtitle}>Markets · Companies · ETFs · QDII Funds</div>
            </div>
          </div>
          <nav className={styles.nav} aria-label="页面切换">
            {([['overview', '概览'], ['ranking', '走势'], ['funds', '基金'], ['companies', '公司'], ['about', '关于']] as const).map(([page, label]) => {
              const active = page === activePage || (page === 'ranking' && activePage === 'history');
              return <a key={page} href={restoredPagePath(page)} aria-current={active ? 'page' : undefined}
                className={`${styles.navButton} ${active ? styles.navButtonActive : ''}`}
                onClick={(event) => navigate(event, page)}>{label}</a>;
            })}
          </nav>
        </div>
      </header>
      {showMarketMeta && (
        <div className={styles.statusBar}>
          <div className={styles.meta}>
            <div className={styles.datetime}>
              <span>
                <span
                  className={`${styles.live} ${!systemStatus ? styles.liveChecking : ''} ${systemStatus?.status === 'degraded' ? styles.liveDegraded : ''} ${systemStatus?.status === 'offline' ? styles.liveOffline : ''}`}
                  title={freshnessLabel}
                  role="img"
                  aria-label={freshnessLabel}
                />
                {time}（北京时间）
              </span>
            </div>
              <div className={styles.fxRow}>
                {displayRates.map((rate) => {
                  const up = rate.changePercent >= 0;
                  return (
                    <span key={rate.currency} className={styles.fxItem}>
                      <span className={styles.fxPair}>{rate.pair}</span>
                      <span className={styles.fxRate}>{rate.rate.toFixed(4)}</span>
                      <span className={up ? styles.fxUp : styles.fxDown}>
                        {up ? '+' : ''}{rate.changePercent.toFixed(2)}%
                      </span>
                    </span>
                  );
                })}
              </div>
          </div>
        </div>
      )}
    </>
  );
}
