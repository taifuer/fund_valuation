import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchDashboardSnapshot, parseDashboardSnapshotPayload, parseSinaVar } from './api';

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
});
