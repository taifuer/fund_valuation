import { MILLION, defineCompany } from './shared';

export default defineCompany({
  "id": "jnj",
  "name": "强生",
  "nameEn": "Johnson & Johnson",
  "ticker": "JNJ",
  "region": "usa",
  "regionLabel": "美国",
  "currency": "USD",
  "sourceName": "Johnson & Johnson 投资者关系",
  "sourceUrl": "https://www.investor.jnj.com/financials/quarterly-results/default.aspx",
  "latestReport": {
    "period": "FY2026 Q2",
    "publishedAt": "2026-07-23",
    "sourceLabel": "Johnson & Johnson FY2026 第二季度 Form 10-Q",
    "sourceUrl": "https://www.sec.gov/Archives/edgar/data/200406/000020040626000153/jnj-20260628.htm"
  },
  "methodologyNote": "公司未持续单列合并营业利润，利润指标采用 GAAP 税前利润；FY2021 起历史财务按 Kenvue 终止经营重述，季度序列从可连续核验的 FY2023 开始。",
  "profitMetricLabel": "税前利润",
  "employeeScope": "年末全球全职等效员工（官方约数）",
  "employeeMarkers": [
    {
      "period": "FY2023",
      "label": "Kenvue 分拆",
      "note": "FY2023 完成 Kenvue 分拆并开始区分员工与全职等效员工，人数前后不可直接比较。"
    }
  ],
  "metricMarkers": [
    {
      "metric": "revenue",
      "period": "FY2021",
      "label": "终止经营重述",
      "note": "FY2021 起按 Kenvue 终止经营后的持续经营收入重述，FY2020 及以前未完全采用同一口径。"
    },
    {
      "metric": "operatingProfit",
      "period": "FY2021",
      "label": "终止经营重述",
      "note": "FY2021 起按 Kenvue 终止经营后的持续经营税前利润重述，FY2020 及以前未完全采用同一口径。"
    },
    {
      "metric": "operatingProfit",
      "period": "FY2023 Q1",
      "label": "诉讼费用",
      "note": "FY2023 Q1 税前利润受到重大滑石粉诉讼费用影响，不能视为经常性经营变化。"
    },
    {
      "metric": "operatingProfit",
      "period": "FY2025 Q1",
      "label": "准备金转回",
      "note": "FY2025 Q1 税前利润包含约 70 亿美元滑石粉诉讼准备金转回，不能视为经常性经营增长。"
    }
  ],
  "moneyScale": MILLION,
  "researchAndDevelopment": {
    "annual": {
      "FY2018": 10775,
      "FY2019": 11355,
      "FY2020": 12159,
      "FY2021": 14277,
      "FY2022": 14135,
      "FY2023": 15085,
      "FY2024": 17232,
      "FY2025": 14665
    },
    "quarterly": {
      "FY2023 Q1": 3455,
      "FY2023 Q2": 3703,
      "FY2023 Q3": 3447,
      "FY2023 Q4": 4480,
      "FY2024 Q1": 3542,
      "FY2024 Q2": 3440,
      "FY2024 Q3": 4952,
      "FY2024 Q4": 5298,
      "FY2025 Q1": 3225,
      "FY2025 Q2": 3516,
      "FY2025 Q3": 3672,
      "FY2025 Q4": 4252,
      "FY2026 Q1": 3527,
      "FY2026 Q2": 3653
    }
  },
  "annual": [
    [
      "FY2018",
      "2018-12-30",
      81581,
      17999,
      135100
    ],
    [
      "FY2019",
      "2019-12-29",
      82059,
      17328,
      132200
    ],
    [
      "FY2020",
      "2021-01-03",
      82584,
      16497,
      134500
    ],
    [
      "FY2021",
      "2022-01-02",
      78740,
      19178,
      141700
    ],
    [
      "FY2022",
      "2023-01-01",
      79990,
      19359,
      152700
    ],
    [
      "FY2023",
      "2023-12-31",
      85159,
      15062,
      131900
    ],
    [
      "FY2024",
      "2024-12-29",
      88821,
      16687,
      138100
    ],
    [
      "FY2025",
      "2025-12-28",
      94193,
      32581,
      138200
    ]
  ],
  "quarterly": [
    [
      "FY2023 Q1",
      "2023-04-02",
      20894,
      -1287
    ],
    [
      "FY2023 Q2",
      "2023-07-02",
      21519,
      6306
    ],
    [
      "FY2023 Q3",
      "2023-10-01",
      21351,
      5217
    ],
    [
      "FY2023 Q4",
      "2023-12-31",
      21395,
      4826
    ],
    [
      "FY2024 Q1",
      "2024-03-31",
      21383,
      3714
    ],
    [
      "FY2024 Q2",
      "2024-06-30",
      22447,
      5748
    ],
    [
      "FY2024 Q3",
      "2024-09-29",
      22471,
      3338
    ],
    [
      "FY2024 Q4",
      "2024-12-29",
      22520,
      3887
    ],
    [
      "FY2025 Q1",
      "2025-03-30",
      21893,
      13631
    ],
    [
      "FY2025 Q2",
      "2025-06-29",
      23743,
      6491
    ],
    [
      "FY2025 Q3",
      "2025-09-28",
      23993,
      7493
    ],
    [
      "FY2025 Q4",
      "2025-12-28",
      24564,
      4966
    ],
    [
      "FY2026 Q1",
      "2026-03-29",
      24062,
      5990
    ],
    [
      "FY2026 Q2",
      "2026-06-28",
      25310,
      6747
    ]
  ]
});
