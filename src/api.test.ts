import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchApiMeta, fetchDashboardSnapshot, fetchFundNavs, parseDashboardSnapshotPayload, parseSinaVar } from './api';
import { storeFundManagementToken } from './fundManagementAuth';

function dashboardPayload(price: number) {
  return {
    schemaVersion: 1,
    quotes: {
      s_sh000001: {
        symbol: 's_sh000001',
        price,
        previousClose: 3180,
        change: price - 3180,
        changePercent: ((price - 3180) / 3180) * 100,
        time: '2026-07-18 10:00:00',
        fetchedAt: Date.now(),
      },
    },
    quotesText: '',
    fxText: '',
    marketStates: {},
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('dashboard API contract', () => {
  it('uses structured quotes only for the supported schema version', () => {
    const snapshot = parseDashboardSnapshotPayload({
      schemaVersion: 1,
      quotes: {
        s_sh000001: {
          symbol: 's_sh000001',
          price: 3200,
          previousClose: 3180,
          change: 20,
          changePercent: 0.63,
          time: '2026-07-02 10:00:00',
          fetchedAt: 123,
        },
      },
      quotesText: '',
      fxText: '',
      marketStates: {},
    }, ['s_sh000001'], 456);

    expect(snapshot.quotes.get('s_sh000001')).toMatchObject({ price: 3200, fetchedAt: 123 });
  });

  it('falls back to the compatibility text for an unsupported schema version', () => {
    const snapshot = parseDashboardSnapshotPayload({
      schemaVersion: 2,
      quotes: {
        s_sh000001: {
          symbol: 's_sh000001',
          price: 9999,
          previousClose: 1,
          changePercent: 1,
          fetchedAt: 123,
        },
      },
      quotesText: 'var hq_str_s_sh000001="上证指数,3200,20,0.63";',
      fxText: '',
      marketStates: {},
    }, ['s_sh000001'], Date.now());

    expect(snapshot.quotes.get('s_sh000001')?.price).toBe(3200);
  });

  it('keeps the KOSPI timestamp because Sina already reports Beijing time', () => {
    const parsed = parseSinaVar(
      'var hq_str_b_KOSPI="韩国KOSPI指数,7648.09,-655.32,-7.89,2:27 AM,14:27:00,2026-07-02,14:33:00,7933.10,8303.41";',
      new Date('2026-07-02T14:34:00+08:00').getTime(),
    );

    expect(parsed?.data.time).toBe('2026-07-02 14:33:00');
  });

  it('uses the regular close as the US post-market change basis', () => {
    const parsed = parseSinaVar(
      'var hq_str_gb_amd="AMD,518.5800,7.00,2026-08-05 08:14:57,33.9400,504.0000,'
      + '530.1300,502.2000,584.7300,149.2200,48463564,29657103,845596879891,3.08,'
      + '168.370000,0.00,0.00,0.00,0.00,1630600640,73,472.8504,-8.82,-45.73,'
      + 'Aug 04 07:59PM EDT,Aug 04 04:00PM EDT,484.6400,11354303,1,2026,0,0,0,0,0,0";',
      new Date('2026-08-05T08:15:00+08:00').getTime(),
    );

    expect(parsed?.data).toMatchObject({
      price: 472.85,
      previousClose: 518.58,
      changePercent: -8.82,
      regularPrice: 518.58,
      session: 'post',
    });
  });

  it('computes the US post-market change when the upstream percent is missing', () => {
    const parsed = parseSinaVar(
      'var hq_str_gb_amd="AMD,518.5800,7.00,2026-08-05 08:14:57,33.9400,504.0000,'
      + '530.1300,502.2000,584.7300,149.2200,48463564,29657103,845596879891,3.08,'
      + '168.370000,0.00,0.00,0.00,0.00,1630600640,73,472.8504,,-45.73,'
      + 'Aug 04 07:59PM EDT,Aug 04 04:00PM EDT,484.6400,11354303,1,2026,0,0,0,0,0,0";',
      new Date('2026-08-05T08:15:00+08:00').getTime(),
    );

    expect(parsed?.data.changePercent).toBeCloseTo((472.8504 / 518.58 - 1) * 100);
  });

  it('parses backend-adapted Japanese and Korean equity quotes', () => {
    const japanese = parseSinaVar(
      'var hq_str_jp6857="Advantest,19320.0000,-250.0000,-1.2775,2026-07-31,14:30:00";',
      new Date('2026-07-31T14:31:00+08:00').getTime(),
    );
    const korean = parseSinaVar(
      'var hq_str_kr005930="Samsung Electronics,162000.0000,1500.0000,0.9346,2026-07-31,14:30:00";',
      new Date('2026-07-31T14:31:00+08:00').getTime(),
    );

    expect(japanese?.data).toMatchObject({
      price: 19320,
      previousClose: 19570,
      changePercent: -1.28,
      time: '2026-07-31 14:30:00',
    });
    expect(korean?.data).toMatchObject({
      price: 162000,
      previousClose: 160500,
      changePercent: 0.93,
      time: '2026-07-31 14:30:00',
    });
  });

  it('keeps a dated Nikkei close across a long weekend', () => {
    const parsed = parseSinaVar(
      'var hq_str_int_nikkei="日经225,64140.90,-2694.64,-4.03,2026-07-17,14:30:01";',
      new Date('2026-07-20T09:30:00+08:00').getTime(),
    );

    expect(parsed?.data).toMatchObject({
      price: 64140.9,
      time: '2026-07-17 14:30:01',
      dateReliable: false,
    });
  });

  it('parses the direct Hang Seng TECH spot quote', () => {
    const parsed = parseSinaVar(
      'var hq_str_hkHSTECH="HSTECH,恒生科技指数,4698.480,4698.480,4720.000,4590.000,4629.510,-68.970,-1.468,0,0,0,0,0,0,0,0,2026/07/24,16:08";',
      new Date('2026-07-24T16:09:00+08:00').getTime(),
    );

    expect(parsed?.data).toMatchObject({
      symbol: 'hkHSTECH',
      price: 4629.51,
      previousClose: 4698.48,
      changePercent: -1.47,
      time: '2026-07-24 16:08:00',
    });
  });

  it('uses browser snapshots only as an error fallback, not instead of polling', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => dashboardPayload(3200) })
      .mockResolvedValueOnce({ ok: true, json: async () => dashboardPayload(3210) })
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchDashboardSnapshot(['s_sh000001'], []);
    const second = await fetchDashboardSnapshot(['s_sh000001'], []);
    const fallback = await fetchDashboardSnapshot(['s_sh000001'], []);

    expect(first?.quotes.get('s_sh000001')?.price).toBe(3200);
    expect(second?.quotes.get('s_sh000001')?.price).toBe(3210);
    expect(fallback?.quotes.get('s_sh000001')?.price).toBe(3210);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('loads a currencies-only snapshot without sending an empty dashboard request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await fetchDashboardSnapshot([], ['KRW']);

    expect(snapshot?.quotes.size).toBe(0);
    expect(snapshot?.marketStates.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/sina?list=fx_skrwcny'));
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/dashboard'));
  });

  it('reads the runtime fund-management mode', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        apiSchemaVersion: 1,
        dashboardSchemaVersion: 1,
        fundManagementMode: 'token',
      }),
    }));

    await expect(fetchApiMeta()).resolves.toMatchObject({ fundManagementMode: 'token' });
  });

  it('attaches the session management token to fund requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    storeFundManagementToken('management-secret');

    await fetchFundNavs(['118001']);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/fundnav?codes=118001'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Fund-Management-Token': 'management-secret' }),
      }),
    );
  });
});
