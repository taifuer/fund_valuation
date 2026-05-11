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
}

export default function Header({ fxRates }: Props) {
  const [time, setTime] = useState(formatTime());
  const displayRates = [...fxRates.values()].filter((rate) => rate.currency !== 'CNY');

  useEffect(() => {
    const timer = setInterval(() => setTime(formatTime()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <Logo />
        <div>
          <h1 className={styles.title}>全球基金估值看板</h1>
          <div className={styles.subtitle}>QDII Active Funds · Real-Time NAV</div>
        </div>
      </div>
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
    </header>
  );
}
