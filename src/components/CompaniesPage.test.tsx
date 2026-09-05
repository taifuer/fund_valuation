import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import CompaniesPage from './CompaniesPage';

describe('CompaniesPage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/companies');
    window.scrollTo = () => undefined;
  });

  it('renders one focused trend with the complete restrained company roster', () => {
    render(<CompaniesPage />);

    expect(screen.getByRole('heading', { name: '公司经营趋势' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByLabelText('地区筛选')).getByRole('button', { name: /全部/ }));
    const companyOptions = screen.getByRole('group', { name: '全部公司' });
    const companyButtons = within(companyOptions).getAllByRole('button');
    expect(companyButtons).toHaveLength(52);
    expect(companyButtons.slice(0, 7).map((button) => button.textContent)).toEqual([
      'Adobe', 'AMD', '阿里巴巴', '谷歌', '亚马逊', '苹果', '应用材料',
    ]);
    expect(within(companyOptions).queryByText('AAPL')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '阿里巴巴' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '阿里巴巴营业收入趋势' })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /苹果/ })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /Arm/ })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /美光/ })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /中芯国际/ })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /高通/ })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /比亚迪/ })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /宁德时代/ })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /特斯拉/ })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /华为/ })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /鸿海精密/ })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /博通/ })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /联发科/ })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /奈飞/ })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: /施耐德电气/ })).toBeInTheDocument();
    expect(screen.queryByText('SAP')).not.toBeInTheDocument();
    expect(screen.queryByText('经营对比')).not.toBeInTheDocument();
  });

  it('shows an official-source report calendar without replacing the company route', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: '财报日历' }));

    expect(screen.getByRole('heading', { name: '财报日历' })).toBeInTheDocument();
    expect(screen.getByLabelText('财报日历')).toBeInTheDocument();
    expect(screen.getByRole('grid', { name: /财报日历/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '选择财报月份' })).toBeInTheDocument();
    expect(screen.getByText('当月事项')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '选择财报月份' }), {
      target: { value: '2026-01' },
    });
    expect(screen.getByRole('grid', { name: '2026 年 1 月财报日历' })).toBeInTheDocument();
    expect(screen.getAllByText('已披露').length).toBeGreaterThan(0);
    expect(window.location.pathname).toBe('/companies');
    expect(window.location.search).toContain('panel=calendar');
  });

  it('links the original latest report when report metadata is available', () => {
    window.history.replaceState({}, '', '/companies?company=pdd');
    render(<CompaniesPage />);

    expect(screen.getByRole('link', { name: '最新报告 · 2026.08.24' }))
      .toHaveAttribute('href', expect.stringContaining('sec.gov/Archives/edgar/data/1737806'));
  });

  it('groups Japan, India, and Korea under the Asia-Pacific filter', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /亚太/ }));

    const companyOptions = screen.getByRole('group', { name: '亚太公司' });
    expect(within(companyOptions).getAllByRole('button')).toHaveLength(4);
    expect(within(companyOptions).getByRole('button', { name: '丰田汽车' })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: '塔塔咨询服务' })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: '三星电子' })).toBeInTheDocument();
    expect(within(companyOptions).getByRole('button', { name: 'SK 海力士' })).toBeInTheDocument();
  });

  it('filters the company picker by name or ticker', () => {
    render(<CompaniesPage />);

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索公司' }), { target: { value: 'QCOM' } });

    const searchResults = screen.getByRole('group', { name: '公司搜索结果' });
    expect(within(searchResults).getAllByRole('button')).toHaveLength(1);
    expect(within(searchResults).getByRole('button', { name: /高通/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: '高通' })).toBeInTheDocument();
  });

  it('supports arrow-key navigation across wrapped company choices', () => {
    render(<CompaniesPage />);

    const alibaba = screen.getByRole('button', { name: /阿里巴巴/ });
    alibaba.focus();
    fireEvent.keyDown(alibaba, { key: 'ArrowRight' });

    const baidu = screen.getByRole('button', { name: /百度/ });
    expect(baidu).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: '百度' })).toBeInTheDocument();
  });

  it('shows the latest disclosure rows by default and expands the complete history on demand', () => {
    render(<CompaniesPage />);

    const summary = screen.getByText('披露明细').closest('summary');
    expect(summary).not.toBeNull();
    const details = summary!.closest('details');
    expect(details).toHaveAttribute('open');
    const table = screen.getByRole('table', { name: '阿里巴巴披露明细' });
    expect(within(table).getAllByRole('row')).toHaveLength(13);
    expect(within(table).getByText('FY2027 Q1')).toBeInTheDocument();
    expect(within(table).queryByText('FY2019 Q1')).not.toBeInTheDocument();

    const showAll = screen.getByRole('button', { name: '显示全部 33 期' });
    expect(showAll).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(showAll);
    expect(within(table).getAllByRole('row')).toHaveLength(34);
    expect(within(table).getByText('FY2019 Q1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起至最近 12 期' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: /百度/ }));
    const baiduTable = screen.getByRole('table', { name: '百度披露明细' });
    expect(within(baiduTable).getAllByRole('row')).toHaveLength(13);
    expect(screen.getByRole('button', { name: '显示全部 34 期' })).toHaveAttribute('aria-expanded', 'false');

    const currentSummary = screen.getByText('披露明细').closest('summary');
    const currentDetails = currentSummary!.closest('details');
    fireEvent.click(currentSummary!);
    expect(currentDetails).not.toHaveAttribute('open');
  });

  it('uses quarterly employee disclosures when the company publishes them', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /腾讯/ }));
    fireEvent.click(screen.getByRole('button', { name: '员工人数' }));

    expect(screen.getByRole('button', { name: '季度' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '半年' })).toBeEnabled();
    expect(screen.getByRole('img', { name: '腾讯员工人数趋势' })).toBeInTheDocument();
    expect(screen.getByText('115,927')).toBeInTheDocument();
  });

  it('opens a focused company trend with exact disclosures and source metadata', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /美国/ }));
    fireEvent.click(screen.getByRole('button', { name: /苹果/ }));

    expect(screen.getByRole('heading', { name: '苹果' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '苹果营业收入趋势' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '苹果官方披露' })).toHaveAttribute(
      'href',
      'https://investor.apple.com/',
    );
    expect(screen.getAllByText('$109B').length).toBeGreaterThan(0);
    expect(window.location.search).toContain('company=apple');
    expect(window.location.search).not.toContain('view=');
  });

  it('uses a concise official disclosure label while preserving source context', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /腾讯/ }));

    const sourceLink = screen.getByRole('link', { name: '腾讯官方披露' });
    expect(sourceLink).toHaveTextContent('官方披露');
    expect(sourceLink).toHaveAttribute('title', '腾讯投资者关系');
    expect(sourceLink).toHaveAttribute(
      'href',
      'https://www.tencent.com/investors/results/',
    );
  });

  it('links each disclosure period to an exact report or a labeled archive', () => {
    window.history.replaceState({}, '', '/companies?company=netflix');
    render(<CompaniesPage />);

    expect(screen.getByRole('link', { name: '奈飞 FY2026 Q2官方报告' }))
      .toHaveAttribute('href', expect.stringContaining('sec.gov/Archives/edgar/data/1065280'));

    fireEvent.click(within(screen.getByLabelText('地区筛选')).getByRole('button', { name: /全部/ }));
    fireEvent.click(screen.getByRole('button', { name: /阿里巴巴/ }));
    expect(screen.getByRole('link', { name: /阿里巴巴 FY2027 Q1官方报告归档/ }))
      .toBeInTheDocument();
  });

  it('shows SMIC IFRS operating profit rather than gross profit', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /中芯国际/ }));

    expect(screen.getByRole('heading', { name: '中芯国际' })).toBeInTheDocument();
    expect(screen.getAllByText('$534M').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: '中芯国际官方披露' })).toHaveAttribute(
      'href',
      'https://www.smics.com/en/site/company_financialSummary',
    );
  });

  it('uses the disclosed profit label when consolidated operating profit is unavailable', () => {
    window.history.replaceState({}, '', '/companies?company=ibm');
    render(<CompaniesPage />);

    expect(screen.getByRole('heading', { name: 'IBM' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '税前利润' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '税前利润率' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '营业利润' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '税前利润' }));
    expect(screen.getByRole('img', { name: 'IBM税前利润趋势' })).toBeInTheDocument();
  });

  it('marks disclosed employee-scope changes and keeps exact annual headcount', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /欧洲/ }));
    fireEvent.click(screen.getByRole('button', { name: /阿斯麦/ }));
    fireEvent.click(screen.getByRole('button', { name: '员工人数' }));

    expect(screen.getByRole('img', { name: '阿斯麦员工人数趋势' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '季度' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '半年' })).toBeDisabled();
    expect(screen.getByText('口径扩展')).toBeInTheDocument();
    expect(screen.getByText(/FY2024 起员工口径纳入 ASML Berlin GmbH/)).toBeInTheDocument();
    expect(screen.getByText('23,247')).toBeInTheDocument();
  });

  it('shows Huawei direct half-year disclosures without inferring quarters', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /华为/ }));

    expect(screen.getByRole('heading', { name: '华为' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '季度' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '半年' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('公司直接披露口径')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /最新报告/ })).toHaveAttribute(
      'href',
      expect.stringContaining('shclearing.com.cn'),
    );

    fireEvent.click(screen.getByRole('button', { name: '研发费用' }));
    expect(screen.getByRole('img', { name: '华为研发费用趋势' })).toBeInTheDocument();
    expect(screen.getByText(/研发费用按公司单列披露口径/)).toBeInTheDocument();
  });

  it('disables unsupported research spending without presenting a false zero', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /美国/ }));
    fireEvent.click(screen.getByRole('button', { name: /Visa/ }));

    expect(screen.getByRole('heading', { name: 'Visa' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '研发费用' })).toBeDisabled();
    expect(screen.getByRole('img', { name: 'Visa营业收入趋势' })).toBeInTheDocument();
  });

  it('shows quarterly research spending where the company reports it', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /联发科/ }));
    fireEvent.click(screen.getByRole('button', { name: '研发费用' }));

    expect(screen.getByRole('button', { name: '季度' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '半年' })).toBeEnabled();
    expect(screen.getByRole('img', { name: '联发科研发费用趋势' })).toBeInTheDocument();
  });

  it('shows pharmaceutical R&D intensity and material methodology events', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /美国/ }));
    fireEvent.click(screen.getByRole('button', { name: /默沙东/ }));
    fireEvent.click(screen.getByRole('button', { name: '研发费用' }));

    expect(screen.getByRole('img', { name: '默沙东研发费用趋势' })).toBeInTheDocument();
    expect(screen.getByText(/占营收/)).toBeInTheDocument();
    expect(screen.getByText('并购费用')).toBeInTheDocument();
    expect(screen.getByText(/FY2023 Q2 研发费用包含 Prometheus Biosciences/)).toBeInTheDocument();
  });

  it('shows year-over-year change as a separate chart view', () => {
    render(<CompaniesPage />);

    expect(screen.getByRole('button', { name: '季度' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '同比' }));

    expect(screen.getByRole('img', { name: '阿里巴巴营业收入同比趋势' })).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByText(/同比按上一财年相同季度/)).toBeInTheDocument();
    expect(window.location.search).toContain('trend=yoy');
  });

  it('returns to the preferred quarterly view after a non-quarterly company', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /华为/ }));
    expect(screen.getByRole('button', { name: '半年' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: /腾讯/ }));
    expect(screen.getByRole('button', { name: '季度' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('trims leading periods without a comparable year from the chart domain', () => {
    window.history.replaceState({}, '', '/companies?company=samsung&trend=yoy');
    render(<CompaniesPage />);

    const chart = screen.getByRole('img', { name: '三星电子营业收入同比趋势' });
    const plottedPoints = Array.from(chart.querySelectorAll('circle'))
      .filter((circle) => circle.getAttribute('r') !== '14');
    const chartWidth = Number(chart.getAttribute('width'));
    const expectedLeft = chartWidth < 520 ? 56 : 68;
    const expectedRight = chartWidth - (chartWidth < 520 ? 10 : 20);

    expect(plottedPoints.length).toBeGreaterThan(2);
    expect(plottedPoints[0]).toHaveAttribute('cx', String(expectedLeft));
    expect(plottedPoints[plottedPoints.length - 1]).toHaveAttribute('cx', String(expectedRight));
  });
});
