import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFundEstimates, fetchFundHoldings } from '../api';
import FundHoldingsPanel from './FundHoldingsPanel';
import type { Fund, FundEstimateProjection, FundEstimateResult } from '../types';

vi.mock('../api', () => ({ fetchFundEstimates: vi.fn(), fetchFundHoldings: vi.fn() }));
vi.mock('./HoldingsTable', () => ({ default: () => <div>Aligned Holdings</div> }));
const fund: Fund = { code: '017436', symbol: '017436', name: 'Test', holdings: [] };
const projection = { kind: 'preview', targetDate: '2026-09-03', asOf: 1,
  inputSignature: 'same-input', snapshotId: '123456789012345678901234' } as FundEstimateProjection;

beforeEach(() => vi.clearAllMocks());
describe('pinned holdings detail', () => {
  it('requests the exact snapshot displayed by the card', async () => {
    vi.mocked(fetchFundEstimates).mockResolvedValue(new Map([[fund.code, { preview: projection, holdings: [] } as unknown as FundEstimateResult]]));
    render(<FundHoldingsPanel fund={fund} projection={projection} marketStates={new Map()} />);
    expect(await screen.findByText('Aligned Holdings')).toBeInTheDocument();
    expect(fetchFundEstimates).toHaveBeenCalledWith([fund.code], projection.snapshotId);
    expect(fetchFundHoldings).not.toHaveBeenCalled();
  });
  it('does not mix updated contributions with an unchanged holdings signature', async () => {
    vi.mocked(fetchFundEstimates).mockResolvedValue(new Map([[fund.code, { preview: {...projection, asOf: 2}, holdings: [] } as unknown as FundEstimateResult]]));
    render(<FundHoldingsPanel fund={fund} projection={projection} marketStates={new Map()} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('等待卡片同步'));
    expect(screen.queryByText('Aligned Holdings')).not.toBeInTheDocument();
  });
});
