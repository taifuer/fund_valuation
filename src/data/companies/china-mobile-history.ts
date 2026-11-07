import type { CompanyReportReference } from '../../types';
import type { RawPoint } from './shared';

// Original consolidated revenue, not the acquisition pro-forma figures shown alongside it.
// Units: CNY million. Dates are the results/statement approval dates printed in the reports.
const annualDisclosures: readonly [number, number, number, string][] = [
  [1998, 26345.393, 12530, '1999-04-28'],
  [1999, 38623, 20243, '2000-04-13'],
  [2000, 64984, 38343, '2001-04-09'],
  [2001, 100331, 38748, '2002-03-18'],
  [2002, 128561, 59633, '2003-03-18'],
  [2003, 158604, 63859, '2004-03-18'],
  [2004, 192381, 88127, '2005-03-11'],
  [2005, 243041, 99104, '2006-03-16'],
  [2006, 295358, 111998, '2007-03-21'],
  [2007, 356959, 127959, '2008-03-19'],
  [2008, 412343, 138368, '2009-03-19'],
  [2009, 452103, 145954, '2010-03-18'],
  [2010, 485231, 164336, '2011-03-16'],
  [2011, 527999, 175336, '2012-03-15'],
  [2012, 560413, 182487, '2013-03-14'],
  [2013, 630177, 197030, '2014-03-20'],
  [2014, 641448, 241550, '2015-03-19'],
  [2015, 668335, 438645, '2016-03-17'],
  [2016, 708421, 460647, '2017-03-23'],
  [2017, 740514, 464656, '2018-03-22'],
  [2018, 736819, 459152, '2019-03-21'],
  [2019, 745917, 456239, '2020-03-19'],
  [2020, 768070, 454332, '2021-03-25'],
];

const interimDisclosures: readonly [number, number, string, number?][] = [
  [1998, 11367.140, '1998-08-31'],
  [1999, 16940, '1999-08-30'],
  [2000, 28897, '2000-08-31'],
  [2001, 48864, '2001-08-16', 38312],
  [2002, 55146, '2002-08-14', 39558],
  [2003, 76657, '2003-08-12', 61859],
  [2004, 86420, '2004-08-18', 65839],
  [2005, 114547, '2005-08-10', 93415],
  [2006, 136979, '2006-08-17', 105456],
  [2007, 166580, '2007-08-16', 118703],
  [2008, 196460, '2008-08-27', 135132],
  [2009, 212913, '2009-08-20', 141206],
  [2010, 229818, '2010-08-19', 153098],
  [2011, 250080, '2011-08-18', 170019],
  [2012, 266530, '2012-08-16', 181000],
  [2013, 303104, '2013-08-15', 188000],
  [2014, 324681, '2014-08-14', 198000],
  // FY2016 H1 restates FY2015 H1 for TieTong. Use that figure to match the FY2015 full year.
  // FY2015-FY2018 interim personnel include, or do not clearly separate, outsourced labor.
  [2015, 345691, '2016-08-11'],
  [2016, 370351, '2016-08-11'],
  [2017, 388871, '2017-08-10'],
  [2018, 391832, '2018-08-09'],
  [2019, 389427, '2019-08-08', 451000],
  [2020, 389863, '2020-08-13', 451000],
];

export const chinaMobileHistoricalAnnual: RawPoint[] = annualDisclosures
  .filter(([year]) => year < 2018)
  .map(([year, revenue, employees]) => [`FY${year}`, `${year}-12-31`, revenue, null, employees]);

export const chinaMobileHistoricalHalfYear: RawPoint[] = interimDisclosures.flatMap(([year, revenue, , employees]) => {
  const annual = annualDisclosures.find(([annualYear]) => annualYear === year)!;
  return [
    [`FY${year} H1`, `${year}-06-30`, revenue, null, employees],
    [`FY${year} H2`, `${year}-12-31`, annual[1] - revenue, null, annual[2]],
  ] satisfies RawPoint[];
});

function officialReference(period: string, publishedAt: string, report: string, label: string): CompanyReportReference {
  return { period, publishedAt, sourceUrl: `https://www.chinamobileltd.com/en/ir/reports/${report}.pdf`, sourceLabel: `中国移动 ${label}` };
}

export const chinaMobileHistoricalReferences: CompanyReportReference[] = [
  ...annualDisclosures.flatMap(([year, , , date]) => [
    ...(year < 2018 ? [officialReference(`FY${year}`, date, `ar${year}`, `${year} 年度报告`)] : []),
    officialReference(`FY${year} H2`, date, `ar${year}`, `${year} 年度报告（H2 为全年减半年；半年来源见数据说明）`),
  ]),
  ...interimDisclosures.map(([year, , date]) => officialReference(
    `FY${year} H1`, date, `ir${year === 2015 ? 2016 : year}`,
    year === 2015 ? '2016 半年报告（2015 同期铁通合并口径重列）' : `${year} 半年报告`,
  )),
];
