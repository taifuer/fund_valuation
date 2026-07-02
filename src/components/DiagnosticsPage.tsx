import { useState } from 'react';
import { fetchQuoteDiagnostics } from '../api';
import styles from './DiagnosticsPage.module.css';

const TOKEN_KEY = 'fund_valuation:diagnostics_token';

function readToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function numberValue(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'number' ? value : 0;
}

export default function DiagnosticsPage() {
  const [token, setToken] = useState(readToken);
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    if (!token.trim()) {
      setError('请输入诊断令牌');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const next = await fetchQuoteDiagnostics(token.trim());
      window.sessionStorage.setItem(TOKEN_KEY, token.trim());
      setPayload(next);
    } catch (reason) {
      setPayload(null);
      setError(reason instanceof Error ? reason.message : '诊断请求失败');
    } finally {
      setLoading(false);
    }
  }

  const background = payload?.backgroundRefresh as Record<string, unknown> | undefined;
  const requestMetrics = payload?.requestMetrics as Record<string, unknown> | undefined;
  const issues = Array.isArray(payload?.issues) ? payload.issues as Array<Record<string, unknown>> : [];

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h2>运行诊断</h2>
          <p>行情快照与后台刷新状态</p>
        </div>
        <div className={styles.authForm}>
          <input
            type="password"
            value={token}
            placeholder="诊断令牌"
            aria-label="诊断令牌"
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void load(); }}
          />
          <button type="button" onClick={load} disabled={loading}>{loading ? '加载中' : '查询'}</button>
        </div>
      </div>
      {error && <div className={styles.error} role="alert">{error}</div>}
      {payload && (
        <>
          <section className={styles.metrics} aria-label="诊断摘要">
            <div><span>状态</span><strong>{String(payload.status ?? '--')}</strong></div>
            <div><span>行情总数</span><strong>{numberValue(payload, 'total')}</strong></div>
            <div><span>正常</span><strong>{numberValue(payload, 'healthy')}</strong></div>
            <div><span>异常</span><strong>{numberValue(payload, 'issueCount')}</strong></div>
            <div><span>兜底</span><strong>{numberValue(payload, 'fallbackCount')}</strong></div>
            <div><span>刷新次数</span><strong>{numberValue(background ?? null, 'runCount')}</strong></div>
            <div><span>进程请求</span><strong>{numberValue(requestMetrics ?? null, 'requestCount')}</strong></div>
            <div><span>平均耗时</span><strong>{numberValue(requestMetrics ?? null, 'averageDurationMs')} ms</strong></div>
            <div><span>最大耗时</span><strong>{numberValue(requestMetrics ?? null, 'maxDurationMs')} ms</strong></div>
          </section>
          <section className={styles.panel}>
            <h3>异常项目</h3>
            {issues.length === 0 ? <div className={styles.empty}>当前没有异常快照</div> : (
              <div className={styles.tableWrap}>
                <table>
                  <thead><tr><th>标的</th><th>状态</th><th>时间</th><th>来源</th><th>原因</th></tr></thead>
                  <tbody>{issues.map((issue, index) => (
                    <tr key={`${String(issue.symbol ?? '')}-${index}`}>
                      <td>{String(issue.symbol ?? '--')}</td>
                      <td>{String(issue.state ?? '--')}</td>
                      <td>{String(issue.quoteTime ?? '--')}</td>
                      <td>{String(issue.source ?? '--')}</td>
                      <td>{String(issue.reason ?? '--')}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
