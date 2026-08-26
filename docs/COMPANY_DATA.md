# 公司数据维护

公司经营数据是随前端版本发布的离线数据，不在页面访问时抓取。每家公司独立存放在 `src/data/companies/`，聚合入口为 `src/data/companyFundamentals.ts`。这种结构便于逐家公司核验、审阅和回滚，也避免一次更新触碰整份数据集。

## 数据口径

- 优先采用公司投资者关系页面、定期报告和业绩公告；监管机构与交易所结构化数据用于发现更新、生成候选和交叉校验。
- 营业收入、营业利润和研发费用保留原始披露币种与 GAAP、IFRS 或公司明确说明的经营口径。
- 直接披露的单季度值优先于累计值。只有全年和前三季度均可核验时，才以全年减前三季度得到第四季度。
- 研发费用和员工人数缺失时保留为空，不根据比例、约数或相邻期间补造。
- 重述、业务拆分、重大收购及统计范围变化通过方法标记保留，不能静默覆盖历史口径。

## 更新流程

1. 查找可能需要更新的公司：

   ```bash
   npm run data:companies:check
   ```

   `--offline` 只检查本地披露周期，`--all` 展示全部 SEC 比对，`--strict` 在发现新报告时返回非零状态。

2. 对 SEC 申报公司生成待审阅候选：

   ```bash
   npm run data:companies:draft -- --ticker=CSCO
   ```

   可通过 `SEC_USER_AGENT` 设置符合 SEC 要求的联系标识。工具读取最新 10-Q/10-K 与 Company Facts，筛选直接季度或完整年度事实，只向标准输出写 JSON，绝不会修改正式数据。8-K、6-K、非标准 XBRL 标签、累计口径和重述仍需回到原始报告人工核验。

3. 更新对应的 `src/data/companies/<company>.ts`，并保存最新报告期间、披露日期和原始链接。录入后执行：

   ```bash
   npm run data:companies:audit
   npm run test:unit
   npm run build
   ```

## 财报日历

日历与公司数据一样离线维护，日期分为两类：

- `已披露`：报告已经发布，链接指向原始报告或监管申报文件。
- `已确认`：公司、监管机构或交易所已正式公布披露日期，链接指向确认公告。

来源按可信度使用：

- [SEC `submissions` 与 Company Facts](https://www.sec.gov/about/developer-resources) 适合识别美国公司已经提交的 10-Q/10-K 和提取候选指标，但不提供可靠的未来披露安排。
- 港交所[董事会会议日期公告](https://www1.hkexnews.hk/search/predefineddoc.xhtml?predefineddocuments=5)和[巨潮资讯预约披露页](https://www.cninfo.com.cn/new/commonUrl?url=data%2Fyuyuepilu)适合核验港股、A 股正式日程；日期变更时需同步更新。
- 公司投资者关系财务日历适合补充其他市场的正式确认日期。
- [Alpha Vantage](https://www.alphavantage.co/documentation/#earnings-calendar) 和 [Finnhub](https://finnhub.io/docs/api/earnings-calendar) 提供财报日历接口，但需要令牌，且未来日期包含预期数据。它们可用于维护时发现候选，不作为页面运行时依赖，也不能直接标记为官方确认。

正式事件维护在 `src/data/companyReportCalendar.ts`。没有原始来源链接的预测日期不进入日历，避免用户把估计时间误认为公司公告。
