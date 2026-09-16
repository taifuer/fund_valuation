import type { CompanyFrequency, CompanyFundamentalPoint } from './types';

export function companyPlotSeries(points: CompanyFundamentalPoint[], values: Array<number | null>,
  frequency: CompanyFrequency, left: number, right: number) {
  const available = points.flatMap((point, index) => {
    const value = values[index];
    return value != null && Number.isFinite(value) ? [{ point, index, value }] : [];
  });
  const time = (date: string) => Date.parse(`${date}T00:00:00Z`);
  const first = available.length ? time(available[0].point.periodEnd) : 0;
  const last = available.length ? time(available[available.length - 1].point.periodEnd) : first;
  const x = (date: string) => left + (last === first ? 0.5 : (time(date) - first) / (last - first)) * (right - left);
  const month = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
  const maxMonths = { annual: 13, half: 7, quarterly: 4 }[frequency];
  const coordinates = available.map((entry, i) => {
    const previous = available[i - 1];
    // Missing metrics or skipped reports must not look like a continuous disclosure.
    const breakBefore = !previous || entry.index !== previous.index + 1
      || month(entry.point.periodEnd) - month(previous.point.periodEnd) > maxMonths;
    return { ...entry, x: x(entry.point.periodEnd), breakBefore };
  });
  return { coordinates, x };
}
