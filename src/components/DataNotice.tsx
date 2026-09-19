import { useEffect, useState } from 'react';
import styles from './DataNotice.module.css';

interface Props {
  loading: boolean;
  message: string;
  error?: string | null;
}

export default function DataNotice({ loading, message, error }: Props) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!loading || error) return;
    const timer = window.setTimeout(() => setSlow(true), 1000);
    return () => window.clearTimeout(timer);
  }, [loading, error]);

  if (error) return <div className={`${styles.notice} ${styles.error}`} role="alert">{error}</div>;
  if (!loading || !slow) return null;
  return <div className={styles.notice} role="status">{message}</div>;
}
