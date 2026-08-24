import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { companyFundamentalsDataset, companySeries } from '../data/companyFundamentals';
import { choiceFromSearch, replaceSearchParams } from '../routing';
import type {
  CompanyFrequency,
  CompanyFundamentalPoint,
  CompanyFundamentals,
  CompanyRegion,
} from '../types';
import styles from './CompaniesPage.module.css';

type MetricKey = 'revenue' | 'operatingProfit' | 'margin' | 'researchAndDevelopment' | 'employees';
type TrendMode = 'value' | 'yoy';

interface Props {
  onStatusMessageChange?: (message: string) => void;
}

interface ChangeValue {
  value: number | null;
  label: string;
}

const FREQUENCIES: Array<{ key: CompanyFrequency; label: string }> = [
  { key: 'quarterly', label: '季度' },
  { key: 'half', label: '半年' },
  { key: 'annual', label: '年度' },
];

const REGIONS = [
  { key: 'china', label: '中国' },
  { key: 'usa', label: '美国' },
  { key: 'europe', label: '欧洲' },
  { key: 'korea', label: '韩国' },
] as const;

const REGION_FILTERS = [{ key: 'all', label: '全部' }, ...REGIONS] as const;
type RegionFilter = 'all' | CompanyRegion;

const METRICS: Array<{ key: MetricKey; label: string }> = [
  { key: 'revenue', label: '营业收入' },
  { key: 'operatingProfit', label: '营业利润' },
  { key: 'margin', label: '营业利润率' },
  { key: 'researchAndDevelopment', label: '研发费用' },
  { key: 'employees', label: '员工人数' },
];

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  CNY: '¥',
  TWD: 'NT$',
  KRW: '₩',
};

const FREQUENCY_KEYS = FREQUENCIES.map((item) => item.key);
const METRIC_KEYS = METRICS.map((item) => item.key);
const TREND_MODE_KEYS: TrendMode[] = ['value', 'yoy'];
const COMPANY_NAME_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function formatMoney(value: number | null, currency: string, precision = 1) {
  if (value == null || !Number.isFinite(value)) return '--';
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const absolute = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const scales = [
    { threshold: 1e12, divisor: 1e12, suffix: 'T' },
    { threshold: 1e9, divisor: 1e9, suffix: 'B' },
    { threshold: 1e6, divisor: 1e6, suffix: 'M' },
  ];
  const scale = scales.find((candidate) => absolute >= candidate.threshold) ?? {
    threshold: 0,
    divisor: 1,
    suffix: '',
  };
  const scaled = absolute / scale.divisor;
  return `${sign}${symbol}${scaled.toLocaleString('zh-CN', {
    maximumFractionDigits: scaled >= 100 ? 0 : precision,
  })}${scale.suffix}`;
}

function formatEmployees(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '--';
  if (value >= 10_000) {
    return `${(value / 10_000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}万`;
  }
  return Math.round(value).toLocaleString('zh-CN');
}

function formatEmployeeDetail(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '--';
  return Math.round(value).toLocaleString('zh-CN');
}

function formatPercent(value: number | null, signed = false) {
  if (value == null || !Number.isFinite(value)) return '--';
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function compactDate(value: string) {
  return value.replace(/-/g, '.');
}

function priorPeriod(period: string) {
  const match = /^FY(\d{4})(.*)$/.exec(period);
  return match ? `FY${Number(match[1]) - 1}${match[2]}` : '';
}

function previousComparablePoint(
  points: readonly CompanyFundamentalPoint[],
  point: CompanyFundamentalPoint,
) {
  const target = priorPeriod(point.period);
  return points.find((candidate) => candidate.period === target);
}

function changeValue(
  points: readonly CompanyFundamentalPoint[],
  point: CompanyFundamentalPoint,
  getter: (candidate: CompanyFundamentalPoint) => number | null,
  profitSemantics = false,
): ChangeValue {
  const previous = previousComparablePoint(points, point);
  const currentValue = getter(point);
  const previousValue = previous ? getter(previous) : null;
  if (currentValue == null || previousValue == null || previousValue === 0) {
    return { value: null, label: '--' };
  }
  const value = ((currentValue - previousValue) / Math.abs(previousValue)) * 100;
  if (profitSemantics && previousValue < 0 && currentValue >= 0) return { value, label: '转盈' };
  if (profitSemantics && previousValue >= 0 && currentValue < 0) return { value, label: '转亏' };
  if (profitSemantics && previousValue < 0 && currentValue < 0) {
    return { value, label: value >= 0 ? '亏损收窄' : '亏损扩大' };
  }
  return { value, label: formatPercent(value, true) };
}

function operatingMargin(point: CompanyFundamentalPoint | undefined) {
  if (!point || point.revenue === 0) return null;
  return (point.operatingProfit / point.revenue) * 100;
}

function researchIntensity(point: CompanyFundamentalPoint | undefined) {
  if (!point || point.researchAndDevelopment == null || point.revenue === 0) return null;
  return (point.researchAndDevelopment / point.revenue) * 100;
}

function changeClass(value: number | null) {
  if (value == null || Math.abs(value) < 0.05) return styles.neutral;
  return value > 0 ? styles.positive : styles.negative;
}

function metricValue(point: CompanyFundamentalPoint, metric: MetricKey) {
  if (metric === 'margin') return operatingMargin(point);
  return point[metric];
}

function metricDisplay(value: number | null, metric: MetricKey, company: CompanyFundamentals) {
  if (metric === 'employees') return formatEmployees(value);
  if (metric === 'margin') return formatPercent(value);
  return formatMoney(value, company.currency);
}

function trendValue(
  points: readonly CompanyFundamentalPoint[],
  point: CompanyFundamentalPoint,
  metric: MetricKey,
  mode: TrendMode,
) {
  return mode === 'value' ? metricValue(point, metric) : metricChange(points, point, metric).value;
}

function trendDisplay(
  value: number | null,
  metric: MetricKey,
  company: CompanyFundamentals,
  mode: TrendMode,
) {
  if (mode === 'value') return metricDisplay(value, metric, company);
  if (metric === 'margin') {
    if (value == null || !Number.isFinite(value)) return '--';
    return `${value >= 0 ? '+' : ''}${value.toFixed(1)} pct`;
  }
  return formatPercent(value, true);
}

function hasMetricSeries(
  company: CompanyFundamentals,
  frequency: CompanyFrequency,
  metric: MetricKey,
) {
  return companySeries(company, frequency).filter((point) => metricValue(point, metric) != null).length >= 2;
}

function hasMetricData(company: CompanyFundamentals, metric: MetricKey) {
  return FREQUENCIES.some((item) => hasMetricSeries(company, item.key, metric));
}

function metricChange(
  points: readonly CompanyFundamentalPoint[],
  point: CompanyFundamentalPoint,
  metric: MetricKey,
) {
  if (metric === 'margin') {
    const previous = previousComparablePoint(points, point);
    const currentMargin = operatingMargin(point);
    const previousMargin = operatingMargin(previous);
    if (currentMargin == null || previousMargin == null) return { value: null, label: '--' };
    const value = currentMargin - previousMargin;
    return { value, label: `${value >= 0 ? '+' : ''}${value.toFixed(1)} pct` };
  }
  return changeValue(
    points,
    point,
    (candidate) => metricValue(candidate, metric),
    metric === 'operatingProfit',
  );
}

interface DetailMetricProps {
  change: ChangeValue;
  value: string;
}

function DetailMetric({ change, value }: DetailMetricProps) {
  return (
    <span className={styles.detailMetric}>
      <strong>{value}</strong>
      {change.label !== '--' && (
        <small className={changeClass(change.value)}>同比 {change.label}</small>
      )}
    </span>
  );
}

interface TrendChartProps {
  company: CompanyFundamentals;
  points: CompanyFundamentalPoint[];
  metric: MetricKey;
  mode: TrendMode;
}

function TrendChart({ company, points, metric, mode }: TrendChartProps) {
  const chartFrameRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(760);
  const [selectedIndex, setSelectedIndex] = useState(Math.max(points.length - 1, 0));
  const values = points
    .map((point) => trendValue(points, point, metric, mode))
    .filter((value): value is number => value != null);
  const validPointIndices = points
    .map((point, index) => trendValue(points, point, metric, mode) == null ? -1 : index)
    .filter((index) => index >= 0);
  const firstPlotIndex = validPointIndices[0] ?? 0;
  const lastPlotIndex = validPointIndices[validPointIndices.length - 1] ?? firstPlotIndex;
  const width = chartWidth;
  const height = 286;
  const compact = width < 520;
  const plot = { left: compact ? 56 : 68, right: compact ? 10 : 20, top: 32, bottom: 44 };
  const innerWidth = width - plot.left - plot.right;
  const innerHeight = height - plot.top - plot.bottom;
  const observedMin = values.length > 0 ? Math.min(...values) : 0;
  const observedMax = values.length > 0 ? Math.max(...values) : 1;
  const rawMin = mode === 'yoy' ? Math.min(observedMin, 0) : observedMin;
  const rawMax = mode === 'yoy' ? Math.max(observedMax, 0) : observedMax;
  const rawSpan = rawMax - rawMin || Math.abs(rawMax) || 1;
  const minValue = rawMin - rawSpan * 0.12;
  const maxValue = rawMax + rawSpan * 0.12;
  const span = maxValue - minValue || 1;
  const x = (index: number) => (
    plot.left + (innerWidth * (index - firstPlotIndex)) / Math.max(lastPlotIndex - firstPlotIndex, 1)
  );
  const y = (value: number) => plot.top + ((maxValue - value) / span) * innerHeight;
  const coordinates = points.map((point, index) => {
    const value = trendValue(points, point, metric, mode);
    return value == null ? null : { x: x(index), y: y(value), value, point, index };
  }).filter((point): point is NonNullable<typeof point> => point != null);
  const maximumLabels = Math.max(2, Math.floor(innerWidth / (compact ? 72 : 84)));
  const labelCount = Math.min(maximumLabels, coordinates.length);
  const labelIndices = new Set(Array.from({ length: labelCount }, (_, index) => (
    coordinates[Math.round((index * (coordinates.length - 1)) / Math.max(labelCount - 1, 1))]?.index
  )).filter((index): index is number => index != null));
  const path = coordinates.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const value = maxValue - (span * index) / 4;
    return { value, y: plot.top + (innerHeight * index) / 4 };
  });
  const activeIndex = Math.min(selectedIndex, Math.max(points.length - 1, 0));
  const activePoint = points[activeIndex];
  const activeValue = activePoint ? trendValue(points, activePoint, metric, mode) : null;
  const activeChange = activePoint ? metricChange(points, activePoint, metric) : { value: null, label: '--' };
  const activeResearchIntensity = activePoint ? researchIntensity(activePoint) : null;
  const markerDefinitions = [
    ...(metric === 'employees' ? company.employeeMarkers ?? [] : []),
    ...(metric === 'margin'
      ? []
      : (company.metricMarkers ?? []).filter((marker) => marker.metric === metric)),
  ];
  const methodologyMarkers = markerDefinitions.flatMap((marker) => {
    const referencePoint = [...company.annual, ...company.quarterly]
      .find((point) => point.period === marker.period);
    const fiscalYear = marker.period.match(/^(FY\d{4})/)?.[1];
    const index = points.findIndex((point) => (
      point.period === marker.period
      || (referencePoint != null && point.periodEnd === referencePoint.periodEnd)
      || (fiscalYear != null && point.period === fiscalYear)
    ));
    return index >= firstPlotIndex && index <= lastPlotIndex ? [{ ...marker, index, x: x(index) }] : [];
  });

  useLayoutEffect(() => {
    const frame = chartFrameRef.current;
    if (!frame) return undefined;
    const updateWidth = () => {
      const nextWidth = Math.max(280, Math.round(frame.getBoundingClientRect().width));
      setChartWidth((current) => current === nextWidth ? current : nextWidth);
    };
    updateWidth();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setSelectedIndex(Math.max(points.length - 1, 0));
  }, [metric, mode, points.length, company.id]);

  if (points.length === 0 || values.length === 0) {
    return <div className={styles.emptyState}>当前口径暂无数据</div>;
  }

  return (
    <div className={styles.chartBlock}>
      <div className={styles.chartReading} aria-live="polite">
        <div>
          <span>{activePoint.period}</span>
          <small>{compactDate(activePoint.periodEnd)}</small>
        </div>
        <strong>
          {mode === 'yoy' ? activeChange.label : trendDisplay(activeValue, metric, company, mode)}
        </strong>
        <em className={changeClass(activeChange.value)}>
          {mode === 'yoy' ? '较上年同期' : `同比 ${activeChange.label}`}
        </em>
        {mode === 'value' && metric === 'researchAndDevelopment' && activeResearchIntensity != null && (
          <small className={styles.researchIntensity}>
            占营收 {formatPercent(activeResearchIntensity)}
          </small>
        )}
      </div>
      <div className={styles.chartFrame} ref={chartFrameRef}>
        <svg
          className={styles.chart}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          role="img"
          aria-label={`${company.name}${METRICS.find((item) => item.key === metric)?.label}${mode === 'yoy' ? '同比' : ''}趋势`}
        >
          {ticks.map((tick) => (
            <g key={tick.y}>
              <line className={styles.gridLine} x1={plot.left} x2={width - plot.right} y1={tick.y} y2={tick.y} />
              <text className={styles.axisLabel} x={plot.left - 10} y={tick.y + 4} textAnchor="end">
                {trendDisplay(tick.value, metric, company, mode)}
              </text>
            </g>
          ))}
          {mode === 'yoy' && minValue <= 0 && maxValue >= 0 && (
            <line
              className={styles.zeroLine}
              x1={plot.left}
              x2={width - plot.right}
              y1={y(0)}
              y2={y(0)}
            />
          )}
          {methodologyMarkers.map((marker) => {
            const placeLeft = marker.x > width - plot.right - 82;
            return (
              <g key={`${marker.period}-${marker.label}`}>
                <line
                  className={styles.methodologyLine}
                  x1={marker.x}
                  x2={marker.x}
                  y1={plot.top}
                  y2={plot.top + innerHeight}
                />
                <text
                  className={styles.methodologyLabel}
                  x={marker.x + (placeLeft ? -6 : 6)}
                  y={plot.top - 10}
                  textAnchor={placeLeft ? 'end' : 'start'}
                >
                  {marker.label}
                </text>
              </g>
            );
          })}
          <path className={styles.trendLine} d={path} />
          {coordinates.map((coordinate) => (
            <g
              key={`${coordinate.point.period}-${coordinate.point.periodEnd}`}
              className={styles.chartPointGroup}
              role="button"
              tabIndex={0}
              aria-label={`${coordinate.point.period} ${mode === 'yoy'
                ? metricChange(points, coordinate.point, metric).label
                : trendDisplay(coordinate.value, metric, company, mode)}`}
              onFocus={() => setSelectedIndex(coordinate.index)}
              onPointerEnter={() => setSelectedIndex(coordinate.index)}
              onPointerDown={() => setSelectedIndex(coordinate.index)}
            >
              <circle className={styles.pointTarget} cx={coordinate.x} cy={coordinate.y} r="14" />
              <circle
                className={`${styles.chartPoint} ${coordinate.index === activeIndex ? styles.chartPointActive : ''}`}
                cx={coordinate.x}
                cy={coordinate.y}
                r={coordinate.index === activeIndex ? 5 : 3.5}
              />
              {labelIndices.has(coordinate.index) && (
                <text
                  className={styles.periodLabel}
                  x={coordinate.x}
                  y={height - 19}
                  textAnchor={coordinate.index === firstPlotIndex
                    ? 'start'
                    : coordinate.index === lastPlotIndex ? 'end' : 'middle'}
                >
                  {coordinate.point.period.replace(/^FY/, '')}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
      {(mode === 'yoy' || metric === 'employees' || metric === 'researchAndDevelopment'
        || methodologyMarkers.length > 0) && (
        <div className={styles.chartNotes} role="note">
          {mode === 'yoy' && (
            <p><strong>*</strong><span>同比按上一财年相同季度、半年或年度计算，不使用相邻期间环比。</span></p>
          )}
          {metric === 'employees' ? (
            <p><strong>*</strong><span>{company.employeeScope}；仅展示公司明确披露的期间。</span></p>
          ) : metric === 'researchAndDevelopment' ? (
            <p><strong>*</strong><span>研发费用按公司单列披露口径；研发强度为研发费用占营业收入比例，缺失期间不推算。</span></p>
          ) : null}
          {methodologyMarkers.map((marker) => (
            <p key={`${marker.period}-${marker.note}`}><strong>*</strong><span>{marker.note}</span></p>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CompaniesPage({ onStatusMessageChange }: Props) {
  const companies = companyFundamentalsDataset.companies;
  const orderedCompanies = useMemo(
    () => [...companies].sort((left, right) => COMPANY_NAME_COLLATOR.compare(left.nameEn, right.nameEn)),
    [companies],
  );
  const [frequency, setFrequency] = useState<CompanyFrequency>(() => (
    choiceFromSearch(window.location.search, 'period', FREQUENCY_KEYS, 'quarterly')
  ));
  const [metric, setMetric] = useState<MetricKey>(() => (
    choiceFromSearch(window.location.search, 'metric', METRIC_KEYS, 'revenue')
  ));
  const [trendMode, setTrendMode] = useState<TrendMode>(() => (
    choiceFromSearch(window.location.search, 'trend', TREND_MODE_KEYS, 'value')
  ));
  const [selectedId, setSelectedId] = useState(
    () => new URLSearchParams(window.location.search).get('company') ?? 'alibaba',
  );
  const [selectedRegion, setSelectedRegion] = useState<RegionFilter>(() => {
    const requestedId = new URLSearchParams(window.location.search).get('company') ?? 'alibaba';
    return companies.find((company) => company.id === requestedId)?.region ?? 'china';
  });
  const [companyQuery, setCompanyQuery] = useState('');

  useEffect(() => {
    onStatusMessageChange?.('');
    return () => onStatusMessageChange?.('');
  }, [onStatusMessageChange]);

  const selectedCompany = companies.find((company) => company.id === selectedId) ?? companies[0];
  const filteredCompanies = useMemo(() => {
    const query = companyQuery.trim().toLocaleLowerCase();
    const regionCompanies = selectedRegion === 'all'
      ? orderedCompanies
      : orderedCompanies.filter((company) => company.region === selectedRegion);
    if (!query) return regionCompanies;
    return regionCompanies.filter((company) => (
      `${company.name} ${company.nameEn} ${company.ticker}`.toLocaleLowerCase().includes(query)
    ));
  }, [companyQuery, orderedCompanies, selectedRegion]);
  const companyListLabel = companyQuery.trim()
    ? '公司搜索结果'
    : selectedRegion === 'all'
      ? '全部公司'
      : `${REGIONS.find((region) => region.key === selectedRegion)?.label ?? ''}公司`;
  const effectiveMetric: MetricKey = hasMetricData(selectedCompany, metric) ? metric : 'revenue';
  const fallbackFrequency = FREQUENCIES.find((item) => (
    hasMetricSeries(selectedCompany, item.key, effectiveMetric)
  ))?.key ?? 'annual';
  const effectiveFrequency: CompanyFrequency = hasMetricSeries(selectedCompany, frequency, effectiveMetric)
    ? frequency
    : fallbackFrequency;
  const trendPoints = companySeries(selectedCompany, effectiveFrequency);
  const latestPoint = trendPoints[trendPoints.length - 1];
  const annualEmployeePoints = selectedCompany.annual.filter((point) => point.employees != null);
  const quarterlyEmployeePoints = selectedCompany.quarterly.filter((point) => point.employees != null);
  const latestAnnualEmployee = annualEmployeePoints[annualEmployeePoints.length - 1];
  const latestQuarterlyEmployee = quarterlyEmployeePoints[quarterlyEmployeePoints.length - 1];
  const useQuarterlyEmployee = latestQuarterlyEmployee != null
    && (latestAnnualEmployee == null || latestQuarterlyEmployee.periodEnd > latestAnnualEmployee.periodEnd);
  const latestEmployeePoint = useQuarterlyEmployee ? latestQuarterlyEmployee : latestAnnualEmployee;
  const employeeComparisonPoints = useQuarterlyEmployee ? quarterlyEmployeePoints : annualEmployeePoints;
  const revenueChange = changeValue(trendPoints, latestPoint, (point) => point.revenue);
  const profitChange = changeValue(trendPoints, latestPoint, (point) => point.operatingProfit, true);
  const employeeChange = latestEmployeePoint
    ? changeValue(employeeComparisonPoints, latestEmployeePoint, (point) => point.employees)
    : { value: null, label: '--' };

  useEffect(() => {
    if (metric !== effectiveMetric) setMetric(effectiveMetric);
  }, [effectiveMetric, metric]);

  const selectCompany = (company: CompanyFundamentals, clearSearch = false) => {
    setSelectedId(company.id);
    if (clearSearch) {
      setCompanyQuery('');
      setSelectedRegion(company.region);
    }
  };

  const selectRegion = (region: RegionFilter) => {
    setCompanyQuery('');
    setSelectedRegion(region);
    if (region === 'all' || selectedCompany.region === region) return;
    const firstCompany = orderedCompanies.find((company) => company.region === region);
    if (firstCompany) setSelectedId(firstCompany.id);
  };

  const updateCompanyQuery = (value: string) => {
    setCompanyQuery(value);
    const query = value.trim().toLocaleLowerCase();
    if (!query) {
      setSelectedRegion(selectedCompany.region);
      return;
    }
    setSelectedRegion('all');
    const firstMatch = orderedCompanies.find((company) => (
      `${company.name} ${company.nameEn} ${company.ticker}`.toLocaleLowerCase().includes(query)
    ));
    if (firstMatch) setSelectedId(firstMatch.id);
  };

  const handleCompanyOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % filteredCompanies.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + filteredCompanies.length) % filteredCompanies.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = filteredCompanies.length - 1;
    else return;

    event.preventDefault();
    const nextCompany = filteredCompanies[nextIndex];
    if (!nextCompany) return;
    selectCompany(nextCompany);
    window.requestAnimationFrame(() => document.getElementById(`company-option-${nextCompany.id}`)?.focus());
  };

  useEffect(() => {
    replaceSearchParams({
      view: null,
      region: null,
      company: selectedCompany.id !== 'alibaba' ? selectedCompany.id : null,
      period: effectiveFrequency === 'quarterly' ? null : effectiveFrequency,
      metric: effectiveMetric !== 'revenue' ? effectiveMetric : null,
      trend: trendMode === 'value' ? null : trendMode,
    });
  }, [effectiveFrequency, effectiveMetric, selectedCompany.id, trendMode]);

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h2>公司经营趋势</h2>
          <p>聚焦营业收入、营业利润、研发费用与员工人数的长期变化</p>
        </div>
      </header>

      <section className={styles.trendLayout}>
        <section className={styles.companyPicker} aria-label="公司选择">
          <div className={styles.pickerToolbar}>
            <div className={styles.regionSwitcher} aria-label="地区筛选">
              {REGION_FILTERS.map((regionItem) => {
                const count = regionItem.key === 'all'
                  ? companies.length
                  : companies.filter((company) => company.region === regionItem.key).length;
                return (
                  <button
                    key={regionItem.key}
                    type="button"
                    className={selectedRegion === regionItem.key ? styles.regionButtonActive : ''}
                    aria-pressed={selectedRegion === regionItem.key}
                    onClick={() => selectRegion(regionItem.key)}
                  >
                    <span>{regionItem.label}</span>
                    <small>{count}</small>
                  </button>
                );
              })}
            </div>
            <label className={styles.companySearch}>
              <span>搜索公司</span>
              <input
                type="search"
                value={companyQuery}
                placeholder="搜索名称或代码"
                autoComplete="off"
                onChange={(event) => updateCompanyQuery(event.target.value)}
              />
            </label>
          </div>
          {filteredCompanies.length > 0 ? (
            <div
              className={styles.companyOptions}
              role="group"
              aria-label={companyListLabel}
            >
              {filteredCompanies.map((company, index) => {
                const active = selectedCompany.id === company.id;
                return (
                  <button
                    key={company.id}
                    id={`company-option-${company.id}`}
                    type="button"
                    className={active ? styles.companyOptionActive : ''}
                    aria-pressed={active}
                    aria-controls="company-trend-panel"
                    onClick={() => selectCompany(company, Boolean(companyQuery.trim()))}
                    onKeyDown={(event) => handleCompanyOptionKeyDown(event, index)}
                  >
                    <strong>{company.name}</strong>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className={styles.pickerEmpty}>未找到匹配公司</p>
          )}
        </section>

        <div
          id="company-trend-panel"
          className={styles.trendContent}
        >
          <header className={styles.companyHeader}>
            <div className={styles.companyIdentity}>
              <h3>{selectedCompany.name}</h3>
              <span className={styles.companyMeta}>
                {selectedCompany.nameEn} · {selectedCompany.ticker} · {selectedCompany.currency}
              </span>
              <a
                className={styles.sourceLink}
                href={selectedCompany.sourceUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`${selectedCompany.name}官方披露`}
                title={selectedCompany.sourceName}
              >
                官方披露
              </a>
            </div>
          </header>

          <div className={styles.kpiStrip}>
            <div>
              <span>{latestPoint.period} 营业收入</span>
              <strong>{formatMoney(latestPoint.revenue, selectedCompany.currency)}</strong>
              <em className={changeClass(revenueChange.value)}>同比 {revenueChange.label}</em>
            </div>
            <div>
              <span>营业利润</span>
              <strong>{formatMoney(latestPoint.operatingProfit, selectedCompany.currency)}</strong>
              <em className={changeClass(profitChange.value)}>同比 {profitChange.label}</em>
            </div>
            <div>
              <span>营业利润率</span>
              <strong>{formatPercent(operatingMargin(latestPoint))}</strong>
              <em>{compactDate(latestPoint.periodEnd)}</em>
            </div>
            <div>
              <span>{latestEmployeePoint ? `${latestEmployeePoint.period} 员工` : '员工人数'}</span>
              <strong>{formatEmployees(latestEmployeePoint?.employees ?? null)}</strong>
              <em className={changeClass(employeeChange.value)}>
                {employeeChange.label === '--' ? '未持续披露' : `同比 ${employeeChange.label}`}
              </em>
            </div>
          </div>

          <div className={styles.trendToolbar}>
            <div className={styles.metricTabs} aria-label="趋势指标">
              {METRICS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  disabled={!hasMetricData(selectedCompany, item.key)}
                  className={`${styles.metricButton} ${effectiveMetric === item.key ? styles.metricButtonActive : ''}`}
                  aria-pressed={effectiveMetric === item.key}
                  onClick={() => setMetric(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className={styles.viewControls}>
              <div className={styles.segmented} aria-label="趋势口径">
                <button
                  type="button"
                  className={`${styles.segmentButton} ${trendMode === 'value' ? styles.segmentButtonActive : ''}`}
                  aria-pressed={trendMode === 'value'}
                  onClick={() => setTrendMode('value')}
                >
                  数值
                </button>
                <button
                  type="button"
                  className={`${styles.segmentButton} ${trendMode === 'yoy' ? styles.segmentButtonActive : ''}`}
                  aria-pressed={trendMode === 'yoy'}
                  onClick={() => setTrendMode('yoy')}
                >
                  同比
                </button>
              </div>
              <div className={styles.segmented} aria-label="趋势周期">
                {FREQUENCIES.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    disabled={!hasMetricSeries(selectedCompany, item.key, effectiveMetric)}
                    className={`${styles.segmentButton} ${effectiveFrequency === item.key ? styles.segmentButtonActive : ''}`}
                    aria-pressed={effectiveFrequency === item.key}
                    onClick={() => setFrequency(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <TrendChart
            company={selectedCompany}
            points={trendPoints}
            metric={effectiveMetric}
            mode={trendMode}
          />

          <details
            key={`${selectedCompany.id}-${effectiveFrequency}`}
            className={styles.disclosureDetails}
            open
          >
            <summary className={styles.detailTableHeading}>
              <span className={styles.detailTableTitle}>
                <strong>披露明细</strong>
                <small>{effectiveFrequency === 'half'
                  ? effectiveMetric === 'employees' ? '取半年度末披露值' : '由完整季度汇总'
                  : '公司原始披露口径'}</small>
              </span>
              <span className={styles.detailTableAction}>
                {trendPoints.length} 期
                <i aria-hidden="true" />
              </span>
            </summary>
            <div className={styles.tableScroller}>
              <table className={styles.detailTable} aria-label={`${selectedCompany.name}披露明细`}>
                <thead>
                  <tr>
                    <th>期间</th>
                    <th>截止日期</th>
                    <th>营业收入</th>
                    <th>营业利润</th>
                    <th>研发费用</th>
                    <th>利润率</th>
                    <th>员工人数</th>
                  </tr>
                </thead>
                <tbody>
                  {[...trendPoints].reverse().map((point) => (
                    <tr key={`${point.period}-${point.periodEnd}`}>
                      <td><strong>{point.period}</strong>{point.derived && <span className={styles.derivedTag}>汇总</span>}</td>
                      <td>{compactDate(point.periodEnd)}</td>
                      <td>
                        <DetailMetric
                          value={formatMoney(point.revenue, selectedCompany.currency)}
                          change={metricChange(trendPoints, point, 'revenue')}
                        />
                      </td>
                      <td>
                        <DetailMetric
                          value={formatMoney(point.operatingProfit, selectedCompany.currency)}
                          change={metricChange(trendPoints, point, 'operatingProfit')}
                        />
                      </td>
                      <td>
                        <DetailMetric
                          value={formatMoney(point.researchAndDevelopment, selectedCompany.currency)}
                          change={metricChange(trendPoints, point, 'researchAndDevelopment')}
                        />
                      </td>
                      <td>
                        <DetailMetric
                          value={formatPercent(operatingMargin(point))}
                          change={metricChange(trendPoints, point, 'margin')}
                        />
                      </td>
                      <td>
                        <DetailMetric
                          value={formatEmployeeDetail(point.employees)}
                          change={metricChange(trendPoints, point, 'employees')}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {selectedCompany.methodologyNote && (
            <p className={styles.companyNote}>* {selectedCompany.methodologyNote}</p>
          )}
        </div>
      </section>

      <footer className={styles.methodology}>
        <strong>口径说明</strong>
        {companyFundamentalsDataset.methodology.map((item) => <span key={item}>{item}</span>)}
      </footer>
    </main>
  );
}
