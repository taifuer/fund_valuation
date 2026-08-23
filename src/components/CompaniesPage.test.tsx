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

    expect(screen.getByRole('heading', { name: '科技公司经营趋势' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /全部/ }));
    const companyOptions = screen.getByRole('group', { name: '全部公司' });
    const companyButtons = within(companyOptions).getAllByRole('button');
    expect(companyButtons).toHaveLength(30);
    expect(companyButtons.slice(0, 7).map((button) => button.textContent)).toEqual([
      'AMD', '阿里巴巴', '谷歌', '亚马逊', '苹果', '应用材料', 'Arm',
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
    expect(screen.queryByText('SAP')).not.toBeInTheDocument();
    expect(screen.queryByText('经营对比')).not.toBeInTheDocument();
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

  it('shows disclosure rows by default and still allows them to be collapsed', () => {
    render(<CompaniesPage />);

    const summary = screen.getByText('披露明细').closest('summary');
    expect(summary).not.toBeNull();
    const details = summary!.closest('details');
    expect(details).toHaveAttribute('open');
    const table = screen.getByRole('table', { name: '阿里巴巴披露明细' });
    expect(within(table).getAllByText(/同比/).length).toBeGreaterThan(10);
    expect(within(table).getByText('FY2022 Q1')).toBeInTheDocument();

    fireEvent.click(summary!);
    expect(details).not.toHaveAttribute('open');
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

  it('keeps Huawei on verified annual disclosures and exposes reported research spending', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /华为/ }));

    expect(screen.getByRole('heading', { name: '华为' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '季度' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '半年' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '年度' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: '研发投入' }));
    expect(screen.getByRole('img', { name: '华为研发投入趋势' })).toBeInTheDocument();
    expect(screen.getByText(/研发投入按公司单列披露口径/)).toBeInTheDocument();
  });

  it('disables unsupported research spending without presenting a false zero', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /鸿海精密/ }));

    expect(screen.getByRole('heading', { name: '鸿海精密' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '研发投入' })).toBeDisabled();
    expect(screen.getByRole('img', { name: '鸿海精密营业收入趋势' })).toBeInTheDocument();
  });

  it('shows quarterly research spending where the company reports it', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /联发科/ }));
    fireEvent.click(screen.getByRole('button', { name: '研发投入' }));

    expect(screen.getByRole('button', { name: '季度' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '半年' })).toBeEnabled();
    expect(screen.getByRole('img', { name: '联发科研发投入趋势' })).toBeInTheDocument();
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

  it('returns to the preferred quarterly view after an annual-only company', () => {
    render(<CompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: /华为/ }));
    expect(screen.getByRole('button', { name: '年度' })).toHaveAttribute('aria-pressed', 'true');

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
