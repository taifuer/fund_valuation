import { useEffect, useId, useMemo, useState } from 'react';
import { fetchLongHistory } from '../api';
import { choiceFromSearch, replaceSearchParams } from '../routing';
import { chartPointerX, fitAxisTicks } from '../chartLayout';
import { nextChartIndex } from '../chartKeyboard';
import { useChartWidth } from '../hooks/useChartWidth';
import { formatReturn } from '../historyMetrics';
import { formatHistoryNumber as number, formatMonthlyDrawdown, monthlyDrawdownTitle, MONTHLY_DRAWDOWN_NOTE, longHistoryChart, nearestHistoryPoint } from '../longHistory';
import type { LongHistoryCatalog, LongHistorySeries } from '../longHistory';
import HistoryComparisonTable from './HistoryComparisonTable';
import DataNotice from './DataNotice';
import styles from './LongHistoryPage.module.css';

const GROUPS = [['all', '全部'], ['china', 'A股'], ['usa', '美股'], ['asia', '亚太'], ['assets', '资产']] as const;
const RANGES = [['5', '近5年'], ['10', '近10年'], ['20', '近20年'], ['30', '近30年'], ['all', '全部']] as const;

function readChoices() {
  const search = window.location.search;
  return {
    asset: new URLSearchParams(search).get('asset') ?? 'INX',
    group: choiceFromSearch(search, 'group', GROUPS.map(item => item[0]), 'all'),
    range: choiceFromSearch(search, 'range', RANGES.map(item => item[0]), 'all'),
    scale: choiceFromSearch(search, 'scale', ['log', 'linear'] as const, 'log'),
    view: choiceFromSearch(search, 'view', ['price', 'change'] as const, 'price'),
  };
}

export default function LongHistoryPage() {
  const noteId = useId();
  const [choices, setChoices] = useState(readChoices);
  const [catalog, setCatalog] = useState<LongHistoryCatalog | null>(null);
  const [series, setSeries] = useState<LongHistorySeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [allYears, setAllYears] = useState(false);
  const { width, ref } = useChartWidth();

  useEffect(() => {
    const pop = () => setChoices(readChoices());
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      if (document.hidden) { timer = setTimeout(load, 15_000); return; }
      setLoading(true);
      try {
        const data = await fetchLongHistory(undefined, attempt > 0);
        if (cancelled) return;
        if (!data) {
          setError('暂无已归档的历史数据');
          timer = setTimeout(load, 15_000);
          return;
        }
        setCatalog(data as LongHistoryCatalog);
        setError('');
      } catch {
        if (!cancelled) setError('历史数据加载失败，请重试');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [attempt]);

  const filtered = catalog?.assets.filter(item => choices.group === 'all' || item.group === choices.group) ?? [];
  const selected = filtered.find(item => item.id === choices.asset)
    ?? filtered.find(item => item.id === 'INX') ?? filtered[0];
  useEffect(() => {
    if (!selected || choices.view !== 'price') return;
    if (series?.asset.id === selected.id && attempt === 0) { setLoading(false); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError('');
    setSeries(null);
    setSelectedIndex(null);
    setAllYears(false);
    const assetId = selected.id;
    async function load() {
      if (document.hidden) { timer = setTimeout(load, 15_000); return; }
      try {
        const payload = await fetchLongHistory(assetId, attempt > 0);
        if (cancelled) return;
        if (payload) { setSeries(payload as LongHistorySeries); setError(''); }
        else { setError('该标的暂无已归档历史'); timer = setTimeout(load, 15_000); }
      } catch {
        if (!cancelled) setError('历史数据加载失败，请重试');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [selected?.id, attempt, choices.view]);

  function choose(updates: Partial<typeof choices>) {
    const next = { ...choices, ...updates };
    setChoices(next);
    setSelectedIndex(null);
    setError('');
    replaceSearchParams({ ...next, year: null });
  }

  const currentSeries = series?.asset.id === selected?.id ? series : null;
  const asset = currentSeries?.asset ?? selected;
  const points = useMemo(() => {
    const all = currentSeries?.points ?? [];
    if (choices.range === 'all' || !all.length) return all;
    const last = all[all.length - 1].period;
    const cutoff = `${Number(last.slice(0, 4)) - Number(choices.range)}${last.slice(4)}`;
    return all.filter(point => point.period >= cutoff);
  }, [currentSeries, choices.range]);
  const logAvailable = points.length > 0 && points.every(point => point.close > 0);
  const chart = useMemo(() => longHistoryChart(points, width, choices.scale === 'log' && logAvailable), [points, width, choices.scale, logAvailable]);
  const index = points.length ? Math.min(selectedIndex ?? points.length - 1, points.length - 1) : null;
  const point = index == null ? null : points[index];
  const position = index == null ? null : chart.positions[index];
  const yearTicks = useMemo(() => {
    const ticks: Array<{ x: number; label: string; anchor: 'start' | 'middle' | 'end' }> = [];
    const years = points.length ? Number(points[points.length - 1].period.slice(0, 4)) - Number(points[0].period.slice(0, 4)) : 0;
    const step = years > 100 ? 20 : years > 50 ? 10 : years > 20 ? 5 : years > 10 ? 2 : 1;
    points.forEach((value, i) => {
      if (i === 0 || i === points.length - 1 || (value.period.slice(5) === '01' && Number(value.period.slice(0, 4)) % step === 0)) {
        const label = value.period.slice(0, 4);
        if (ticks[ticks.length - 1]?.label !== label) ticks.push({ x: chart.positions[i].x, label,
          anchor: i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle' });
      }
    });
    return fitAxisTicks(ticks);
  }, [points, chart]);
  const annual = asset?.annual ?? [];
  const performance = asset?.performance?.[choices.range];
  const candidate = catalog?.comparisons?.[choices.group]?.[choices.range];
  const comparison = choices.range === 'all' && !candidate?.independentPeriods ? undefined : candidate;
  const busy = choices.view === 'change' ? !catalog && loading : loading;
  const startPeriod = points[0]?.period ?? performance?.startPeriod;
  const endPeriod = points[points.length - 1]?.period ?? performance?.endPeriod;
  const returnClass = (value: number | null | undefined) => value == null ? styles.missing : value >= 0 ? styles.up : styles.down;

  function pointer(event: React.PointerEvent<SVGSVGElement>) {
    const x = chartPointerX(event.currentTarget, event.clientX, event.clientY, width);
    setSelectedIndex(nearestHistoryPoint(x, chart.positions));
  }

  return (
    <section className={styles.page} aria-label="长期历史" aria-busy={busy}>
      <div className={styles.toolbar}>
      <div className={styles.groups} role="group" aria-label="历史资产类别">
        {GROUPS.map(([key, label]) => <button type="button" key={key} aria-pressed={choices.group === key}
          className={`${styles.segmentButton} ${choices.group === key ? styles.segmentButtonActive : ''}`}
          onClick={() => {
            const first = catalog?.assets.find(item => key === 'all' || item.group === key);
            choose({ group: key, ...(key !== 'all' && selected?.group !== key && first ? { asset: first.id } : {}) });
          }}>{label}</button>)}
      </div>
      <div className={`${styles.segmented} ${styles.modes}`} role="tablist" aria-label="历史视图">
        {([['price', '走势'], ['change', '涨幅']] as const).map(([value, label]) => <button key={value} type="button"
          role="tab" aria-selected={choices.view === value} id={`history-view-${value}`} aria-controls="history-panel"
          tabIndex={choices.view === value ? 0 : -1}
          className={`${styles.segmentButton} ${choices.view === value ? styles.segmentButtonActive : ''}`}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const view = event.key === 'Home' ? 'price' : event.key === 'End' ? 'change' : value === 'price' ? 'change' : 'price';
            choose({ view });
            document.getElementById(`history-view-${view}`)?.focus();
          }}
          onClick={() => choose({ view: value })}>{label}</button>)}
      </div>
      <div className={styles.rangeControl} role="group" aria-label="走势范围">
        <div className={`${styles.segmented} ${styles.ranges}`}>
          {RANGES.map(([value, label]) => <button key={value} type="button" aria-pressed={choices.range === value}
            className={`${styles.segmentButton} ${choices.range === value ? styles.segmentButtonActive : ''}`}
            onClick={() => choose({ range: value })}>{label}</button>)}
        </div>
        <div className={styles.mobileRange}>
        <select className={styles.rangeSelect} aria-label="历史时间区间" value={choices.range}
          onPointerDown={event => { event.currentTarget.dataset.pointerFocus = 'true'; }}
          onKeyDown={event => { if (event.key !== 'Escape') delete event.currentTarget.dataset.pointerFocus; }}
          onBlur={event => { delete event.currentTarget.dataset.pointerFocus; }}
          onChange={event => choose({ range: event.target.value as typeof choices.range })}>
          {RANGES.map(([value, label]) => <option key={value} value={value}>
            {label}
          </option>)}
        </select>
        </div>
      </div>
      </div>
      <div id="history-panel" role="tabpanel" aria-labelledby={`history-view-${choices.view}`}>
      {choices.view === 'price' && <div className={styles.assets} role="group" aria-label="历史标的">
        {filtered.map(item => <button type="button" className={styles.assetChoice} key={item.id} aria-pressed={selected?.id === item.id}
          onClick={() => choose({ asset: item.id })}>{item.name}</button>)}
      </div>}
      {error && <div role="status" className={styles.message}>{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div>}
      {busy && !error && !currentSeries && <div className={styles.placeholder} aria-busy="true">
        <DataNotice loading message="历史数据加载中..." />
      </div>}
      {choices.view === 'change' && catalog && !comparison && !error && <div role="status" className={styles.message}>
        区间结果待更新<button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button>
      </div>}
      {choices.view === 'change' && catalog && comparison && <HistoryComparisonTable comparison={comparison} assets={filtered}
        onSelect={id => choose({ asset: id, view: 'price' })} />}
      {choices.view === 'price' && asset && currentSeries && <>
        <div className={styles.assetHeader}>
          <h3>{asset.name}</h3>
          <div className={styles.segmented} role="group" aria-label="坐标刻度">
            <button type="button" className={`${styles.segmentButton} ${choices.scale === 'linear' || !logAvailable ? styles.segmentButtonActive : ''}`} aria-pressed={choices.scale === 'linear' || !logAvailable} onClick={() => choose({ scale: 'linear' })}>线性</button>
            <button type="button" className={`${styles.segmentButton} ${choices.scale === 'log' && logAvailable ? styles.segmentButtonActive : ''}`} disabled={!logAvailable} aria-pressed={choices.scale === 'log' && logAvailable} onClick={() => choose({ scale: 'log' })}>对数</button>
          </div>
        </div>
        <div className={styles.summary}>
          <dl>
            <div><dt aria-describedby={`${noteId}-change`}>区间涨幅<sup className={styles.noteMark} aria-hidden="true">*</sup></dt><dd className={returnClass(performance?.change)} title={performance?.reason}>{formatReturn(performance?.change ?? null)}</dd></div>
            <div><dt aria-describedby={`${noteId}-cagr`}>年化涨幅<sup className={styles.noteMark} aria-hidden="true">*</sup></dt><dd className={returnClass(performance?.cagr)} title={performance?.reason || performance?.cagrReason}>{formatReturn(performance?.cagr ?? null)}</dd></div>
            <div><dt aria-describedby={`${noteId}-monthlyDrawdown`}>回撤<sup className={styles.noteMark} aria-hidden="true">*</sup></dt><dd className={styles.drawdown} title={monthlyDrawdownTitle(performance)}>{formatMonthlyDrawdown(performance)}</dd></div>
          </dl>
          <span>{startPeriod ?? '--'} 至 {endPeriod ?? '--'}</span>
        </div>
        {performance?.cagrReason && !performance.reason && <p className={styles.metricNote}>{performance.cagrReason}</p>}
        <div className={styles.point} aria-live="polite">
          <span title={point?.date}>{point?.period ?? '--'}</span>
          <strong>{number(point?.close ?? null)}</strong>
          <span>{asset.unit}</span>
        </div>
        <svg ref={ref} className={styles.chart} viewBox={`0 0 ${width} 296`} role="img" aria-label={`${asset.name}长期走势`}
          tabIndex={points.length ? 0 : -1} onPointerMove={pointer} onPointerDown={pointer}
          onKeyDown={event => {
            const next = nextChartIndex(event.key, selectedIndex, points.length);
            if (next != null) { event.preventDefault(); setSelectedIndex(next); }
          }}>
          {chart.ticks.map((tick, i) => <g key={i}>
            <line x1={chart.left} x2={chart.right} y1={tick.y} y2={tick.y} className={styles.gridline} />
            <text className={styles.axisLabel} x={chart.left - 10} y={tick.y + 4} textAnchor="end">{number(tick.value, true)}</text>
          </g>)}
          <path d={chart.path} className={styles.line} />
          {position && <g>
            {selectedIndex != null && <g data-testid="history-crosshair">
              <line x1={position.x} x2={position.x} y1={chart.top} y2={chart.bottom} className={styles.crosshair} />
              <line x1={chart.left} x2={chart.right} y1={position.y} y2={position.y} className={styles.crosshair} />
            </g>}
            <circle cx={position.x} cy={position.y} r={4} className={`${styles.dot} ${selectedIndex != null ? styles.dotActive : ''}`} />
          </g>}
          {yearTicks.map(tick => <text className={styles.axisLabel} key={`${tick.label}-${tick.x}`} x={tick.x} y={279} textAnchor={tick.anchor}>{tick.label}</text>)}
          {!points.length && !loading && <text className={styles.axisLabel} x={width / 2} y={145} textAnchor="middle">暂无可用历史数据</text>}
        </svg>
        <div className={styles.tableHeading}><h3>年度收益</h3></div>
        <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="年度收益表格">
          <table className={styles.table} aria-label={`${asset.name}年度收益`}>
            <colgroup><col className={styles.yearCol} /><col /><col className={styles.annualDrawdownCol} /><col /><col /><col /></colgroup>
            <thead><tr><th scope="col">年度</th><th scope="col" aria-describedby={`${noteId}-change`}>涨幅<sup className={styles.noteMark} aria-hidden="true">*</sup></th><th scope="col" title={MONTHLY_DRAWDOWN_NOTE} aria-describedby={`${noteId}-monthlyDrawdown`}>回撤<sup className={styles.noteMark} aria-hidden="true">*</sup></th><th scope="col">期末收盘</th><th scope="col">基准收盘</th><th scope="col">截至</th></tr></thead>
            <tbody>{(allYears ? annual : annual.slice(0, 10)).map(row => <tr key={row.year}>
              <th scope="row">{row.year}{row.partialYear && <small>首段</small>}</th>
              <td className={row.return == null ? styles.missing : row.return >= 0 ? styles.up : styles.down}>
                {row.return == null ? '--' : formatReturn(row.return)}
                {row.reason && <small>{row.reason}</small>}
                {row.partialYear && <small>{row.startDate?.slice(0, 7)} 起</small>}
              </td>
              <td className={styles.drawdown} title={monthlyDrawdownTitle(row)}>{formatMonthlyDrawdown(row)}{row.monthlyDrawdownReason && !row.reason && <small>{row.monthlyDrawdownReason}</small>}</td>
              <td>{number(row.endClose)}</td><td title={row.startDate ?? undefined}>{number(row.startClose)}</td>
              <td className={styles.date} title={row.endDate ?? undefined}>{row.endDate?.slice(0, 7) ?? '--'}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {annual.length > 10 && <div className={styles.more}><button type="button" aria-expanded={allYears} onClick={() => setAllYears(!allYears)}>
          {allYears ? '收起历史年度' : `显示全部 ${annual.length} 个年度`}
        </button></div>}
        <div className={styles.notes}>
          <p id={`${noteId}-change`}>* 涨幅：区间按起止月末计算；年度以上年末为基准，首段从最早可用月末起算，不代表完整年度或上市首日以来收益。</p>
          <p id={`${noteId}-cagr`}>* 年化涨幅：所选区间的复合年化涨幅，不是年度涨幅的平均值；不足一年不计算。</p>
          <p id={`${noteId}-monthlyDrawdown`}>* 回撤：{MONTHLY_DRAWDOWN_NOTE}走势对应所选区间，年度每年重置；缺月或数据不足时留空。</p>
          <p>{asset.note}按完整月份统计，当前月份不纳入；不含汇率和持有成本。
            {asset.missingMonths?.length ? ` 缺少 ${asset.missingMonths.length} 个月的有效月末记录。` : ''}{asset.refreshFailed ? ' 最新来源检查失败，保留已验证历史。' : ''}</p>
        </div>
        <p className={styles.sourceNote}>数据来源：{asset.sources.join('、') || '待补全'}。</p>
      </>}
      </div>
    </section>
  );
}
