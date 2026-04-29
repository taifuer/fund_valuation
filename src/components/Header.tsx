import { useState, useEffect } from 'react';
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

export default function Header() {
  const [time, setTime] = useState(formatTime());

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
      <div className={styles.datetime}>
        <span className={styles.live} />
        {time}（北京时间）
      </div>
    </header>
  );
}
