import type { ReactNode } from 'react';
import styles from './PageHeading.module.css';

interface Props {
  title: ReactNode;
  description?: string;
  children?: ReactNode;
}

export default function PageHeading({ title, description, children }: Props) {
  return (
    <header className={styles.header}>
      <div className={styles.content}>
        <div className={styles.copy}>
          <h2 className={styles.title}>{title}</h2>
          {description && <div className={styles.description}>{description}</div>}
        </div>
        {children}
      </div>
    </header>
  );
}
