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
  const historyCoverage = payload?.historyCoverage as Record<string, unknown> | undefined;
  const coverageSummary = historyCoverage?.summary as Record<string, unknown> | undefined;
  const coverageFunds = Array.isArray(historyCoverage?.funds)
    ? historyCoverage.funds as Array<Record<string, unknown>>
    : [];
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
            <div><span>缺净值基金</span><strong>{numberValue(coverageSummary ?? null, 'fundsWithoutNav')}</strong></div>
            <div><span>持仓缺口</span><strong>{numberValue(coverageSummary ?? null, 'missingHoldingPeriods')}</strong></div>
            <div><span>缺历史标的</span><strong>{numberValue(coverageSummary ?? null, 'marketsWithoutHistory')}</strong></div>
            <div><span>汇率缺失</span><strong>{numberValue(coverageSummary ?? null, 'fxCurrenciesMissing')}</strong></div>
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
          <section className={styles.panel}>
            <h3>历史数据覆盖</h3>
            {coverageFunds.length === 0 ? <div className={styles.empty}>暂无覆盖度数据</div> : (
              <div className={styles.tableWrap}>
                <table>
                  <thead><tr><th>基金</th><th>净值截止</th><th>持仓季度</th><th>缺失报告期</th></tr></thead>
                  <tbody>{coverageFunds.map((fund) => {
                    const nav = fund.nav as Record<string, unknown> | undefined;
                    const missing = Array.isArray(fund.missingHoldingPeriods) ? fund.missingHoldingPeriods.map(String) : [];
                    return (
                      <tr key={String(fund.code ?? '')}>
                        <td>{String(fund.code ?? '--')}</td>
                        <td>{String(nav?.endDate ?? '--')}</td>
                        <td>{numberValue(fund, 'holdingPeriodCount')} / {numberValue(fund, 'expectedHoldingPeriodCount')}</td>
                        <td>{missing.length ? `${missing.slice(0, 3).join('、')}${missing.length > 3 ? ` 等${missing.length}期` : ''}` : '完整'}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
