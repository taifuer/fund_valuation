import { Component, type ReactNode } from 'react';
import styles from './PageErrorBoundary.module.css';

export default class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className={styles.error} role="alert">
        <h2>页面暂时无法显示</h2>
        <p>网络连接异常或站点已更新，请刷新后重试。</p>
        <button type="button" onClick={() => window.location.reload()}>刷新页面</button>
      </section>
    );
  }
}
