import styles from './Logo.module.css';

export default function Logo() {
  return (
    <div className={styles.logo} aria-hidden="true">
      <img className={styles.mark} src="/brand-mark.png" alt="" draggable={false} />
    </div>
  );
}
