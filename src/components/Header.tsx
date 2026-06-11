import { useState, useEffect } from 'react';
import type { FxRateData } from '../types';
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
  activePage: 'overview' | 'ranking';
  onPageChange: (page: 'overview' | 'ranking') => void;
}

const FX_ORDER = ['USD', 'EUR', 'JPY', 'KRW', 'HKD'];

export default function Header({ fxRates, activePage, onPageChange }: Props) {
  const [time, setTime] = useState(formatTime());
  const displayRates = FX_ORDER.map((currency) => fxRates.get(currency)).filter((rate): rate is FxRateData => rate != null);

  useEffect(() => {
    const timer = setInterval(() => setTime(formatTime()), 1000);
    return () => clearInterval(timer);
  }, []);

  function reloadToTop() {
    window.location.href = `${window.location.origin}${window.location.pathname}`;
  }

  return (
    <>
      <header className={styles.header}>
        <div className={styles.inner}>
          <div className={styles.brand}>
            <Logo />
            <div>
              <h1 className={styles.title}>
                <button type="button" className={styles.titleButton} onClick={reloadToTop}>
                  全球基金估值看板
                </button>
              </h1>
              <div className={styles.subtitle}>QDII Active Funds · Market Assets</div>
            </div>
          </div>
          <nav className={styles.nav} aria-label="页面切换">
            <button
              type="button"
              className={`${styles.navButton} ${activePage === 'overview' ? styles.navButtonActive : ''}`}
              onClick={() => onPageChange('overview')}
            >
              概览
            </button>
            <button
              type="button"
              className={`${styles.navButton} ${activePage === 'ranking' ? styles.navButtonActive : ''}`}
              onClick={() => onPageChange('ranking')}
            >
              排行
            </button>
          </nav>
        </div>
      </header>
      <div className={styles.statusBar}>
        <div className={styles.meta}>
          <div className={styles.datetime}>
            <span className={styles.live} />
            {time}（北京时间）
          </div>
          {displayRates.length > 0 && (
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
          )}
        </div>
      </div>
    </>
  );
}
