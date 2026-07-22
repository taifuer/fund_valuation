import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFundProfiles, fetchFundPurchaseStatuses, fetchFundReturnSummaries } from '../api';
import FundProfilePanel from './FundProfilePanel';

vi.mock('../api', () => ({
  fetchFundProfiles: vi.fn(),
  fetchFundPurchaseStatuses: vi.fn(),
  fetchFundReturnSummaries: vi.fn(),
}));

describe('FundProfilePanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads current profile, purchase status, and official returns on demand', async () => {
    vi.mocked(fetchFundProfiles).mockResolvedValue(new Map([['017436', {
      inceptionDate: '2023-03-02',
      assetScale: '47.06亿元',
      scaleDate: '2026-06-30',
      managementFee: '1.20%',
      custodianFee: '0.20%',
      salesServiceFee: '0.00%',
    }]]));
    vi.mocked(fetchFundPurchaseStatuses).mockResolvedValue(new Map([['017436', {
      code: '017436', name: '华宝纳斯达克精选', fundType: 'QDII', navDate: '2026-07-21',
      purchaseStatus: '限大额', redeemStatus: '开放赎回', nextOpenDate: '', minPurchase: '10',
      dailyLimit: '10000', feeRate: '0.12', fetchedAt: Date.UTC(2026, 6, 22),
    }]]));
    vi.mocked(fetchFundReturnSummaries).mockResolvedValue(new Map([['017436', {
      code: '017436', asOf: '2026-07-21', ranges: {
        '1w': { key: '1w', label: '近1周', returnPercent: 2.35, startDate: '2026-07-14', endDate: '2026-07-21', startNav: 2.18, endNav: 2.23 },
      },
    }]]));

    render(<FundProfilePanel fundCode="017436" />);
    expect(screen.getByText('基金资料加载中...')).toBeInTheDocument();
    expect(await screen.findByText('47.06亿元')).toBeInTheDocument();
    expect(screen.getByText('2026年6月30日', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('限大额')).toBeInTheDocument();
    expect(screen.getByText('+2.35%')).toBeInTheDocument();
  });
});
