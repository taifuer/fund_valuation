import styles from './Logo.module.css';

export default function Logo() {
  return (
    <div className={styles.logo} aria-hidden="true">
      <span className={styles.globe}>🌐</span>
      <span className={styles.arrow}>📈</span>
    </div>
  );
}
