import { MILLION, defineCompany } from './shared';

export default defineCompany({
  "id": "huawei",
  "name": "华为",
  "nameEn": "Huawei",
  "ticker": "非上市",
  "region": "china",
  "regionLabel": "中国",
  "currency": "CNY",
  "sourceName": "Huawei Annual Reports",
  "sourceUrl": "https://www.huawei.com/en/annual-report/",
  "methodologyNote": "华为稳定披露完整年度收入、营业利润、研发费用与员工规模，不依据经营简报拆分季度。",
  "employeeScope": "年末全球员工（公司披露约数）",
  "moneyScale": MILLION,
  "researchAndDevelopment": {
    "annual": {
      "FY2018": 101509,
      "FY2019": 131659,
      "FY2020": 141893,
      "FY2021": 142666,
      "FY2022": 161536,
      "FY2023": 164721,
      "FY2024": 179687,
      "FY2025": 192300
    }
  },
  "annual": [
    [
      "FY2018",
      "2018-12-31",
      721202,
      73287,
      188000
    ],
    [
      "FY2019",
      "2019-12-31",
      858833,
      77835,
      194000
    ],
    [
      "FY2020",
      "2020-12-31",
      891368,
      72501,
      197000
    ],
    [
      "FY2021",
      "2021-12-31",
      636807,
      121412,
      195000
    ],
    [
      "FY2022",
      "2022-12-31",
      642338,
      42216,
      207000
    ],
    [
      "FY2023",
      "2023-12-31",
      704174,
      104401,
      207000
    ],
    [
      "FY2024",
      "2024-12-31",
      862072,
      79361,
      209000
    ],
    [
      "FY2025",
      "2025-12-31",
      880941,
      96937,
      213000
    ]
  ],
  "quarterly": []
});
