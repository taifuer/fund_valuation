# 公司数据维护

公司经营数据是随前端版本发布的离线数据，不在页面访问时抓取。每家公司独立存放在 `src/data/companies/`，聚合入口为 `src/data/companyFundamentals.ts`。这种结构便于逐家公司核验、审阅和回滚，也避免一次更新触碰整份数据集。

## 数据口径

- 优先采用公司投资者关系页面、定期报告和业绩公告；监管机构与交易所结构化数据用于发现更新、生成候选和交叉校验。
- 营业收入、利润和研发指标保留原始披露币种与 GAAP、IFRS 或公司明确说明的报表口径；若公司未持续披露合并营业利润或标准研发费用，页面会明确标注采用的替代口径。
- 直接披露的单季度值优先于累计值。只有全年和前三季度均可核验时，才以全年减前三季度得到第四季度。
- 研发指标和员工人数缺失时保留为空，不根据比例、约数或相邻期间补造。
- 重述、业务拆分、重大收购及统计范围变化通过方法标记保留，不能静默覆盖历史口径。
- 披露明细中的“报告”指向该期间已核验的原始报告；“归档”仅指向公司官方历史报告入口，表示该期间尚未建立精确文档映射，不能视作逐期核验链接。

## 行业筛选

`src/data/companyIndustries.ts` 维护公司页的主营业务分组，只用于导航，不宣称是 GICS 等官方分类或投资风格标签。每家公司仅归入一组，新增公司时必须同时补齐映射；测试检查遗漏、重复及无效代码。

多业务公司按主要经营业务归类：三星、小米、华为归入电子与通信，亚马逊归入互联网与电商，博通归入半导体，IBM 归入软件与服务。该分组不代表公司仅经营该项业务，业务结构发生显著变化时人工复核。零售与支付服务单独列组，不为减少选项而合并无关业务。

地区、行业、名称或代码搜索取交集。地区计数反映行业和搜索条件下的公司数量；行业子类别的计数反映地区和搜索条件下的公司数量，不受当前所选行业限制，“全部行业”不显示数量。筛选保留在 URL 中；无匹配结果时不展示筛选外的公司详情，可清除筛选恢复完整列表。首次进入默认美国、全部行业，并选择按英文名称排序的首家公司；链接中明确指定的公司和地区优先。仅使用离线元数据，不增加接口请求。

## 更新流程

1. 查找可能需要更新的公司：

   ```bash
   npm run data:companies:check
   ```

   `--offline` 只检查本地披露周期，`--all` 展示全部 SEC 与非美来源结果，`--strict` 在发现报告候选、来源故障或访问受限时返回非零状态。联网模式串行检查 SEC 申报及中国、欧洲和亚太公司的官方披露归档；`--companies=adbe,oracle` 可缩小范围，`--output=/tmp/company-review.json` 可保存待审阅结果。官方归档的 `403`、`429` 或超时归为“访问受限”，SEC 请求失败单独列出；都不能当作“没有更新”。JSON 的 `summary` 和 Actions Summary 单独列出未完成核验的来源，归档可访问不等于财务数字已核验。

   SEC 检查不只比较最新报告期：同时检查 10-Q、10-K、20-F、40-F、近期修订报告，以及已披露期间后续提交的正式报告，提示员工人数、研发费用等待核查字段。通过美国上市代码识别的非美公司也参与检查。最近 45 天的 8-K / 6-K 每家公司最多核查两份，串行读取正文和同一申报目录下最多两份业绩附件，发现候选后仍需人工确认财务期间和 GAAP / IFRS 口径。8-K 的事件日期不能用作财季截止日，季度未披露员工人数也不视作待补缺口。

   “未发现更新披露”只表示本次检查范围内未发现候选，不保证所有数据已完整。显式记录的原始报告表示已审阅；自动生成的来源索引只定位文件，不能代替核验。业绩公告先发布、正式财报后补充的情况应分别复核，避免同一报告期漏掉新增字段。

2. 对 SEC 申报公司生成待审阅候选：

   ```bash
   npm run data:companies:draft -- --ticker=CSCO
   ```

   日常维护优先使用批量增量模式，一次检查全部 SEC 公司，只为确有新申报的公司生成候选：

   ```bash
   npm run data:companies:draft -- --all-updates
   ```

   可通过 `SEC_USER_AGENT` 设置符合 SEC 要求的联系标识。工具读取最新 10-Q/10-K 与 Company Facts，筛选直接季度或完整年度事实，只向标准输出写 JSON，绝不会修改正式数据。8-K、6-K、非标准 XBRL 标签、累计口径和重述仍需回到原始报告人工核验。

3. 更新对应的 `src/data/companies/<company>.ts`，在 `reportReferences` 中保存每个已核验期间的披露日期和原始链接；无法确认精确文件时保留官方归档回退，不填猜测链接。录入后执行：

   ```bash
   npm run data:companies:audit
   npm run test:unit
   npm run build
   ```

4. 公司数据核验通过后，同步当年 SEC 正式申报日历：

   ```bash
   npm run data:companies:calendar -- --year=2026 --write
   ```

   命令只为离线数据中已经存在的报告期间生成事件；如出现 `pending`，应先完成财报数据更新，不能只把申报日期写进日历。

## 逐期来源补全

```bash
npm run data:companies:sources -- --write
npm run data:companies:sources -- --company=apple --write
```

工具串行读取 SEC 当前及历史申报索引，按真实财年截止日和报告类型精确匹配，生成 `src/data/companyReportSources.sec.ts`。失败时不改写索引；既有来源保留，人工核验的 `reportReferences` 优先。它只补来源链接，不核验或改写每个财务数值，不把推导的 Q4 自动指向单个报告，也不自动覆盖重述口径。非美公司继续以逐期官方报告人工核验，无法精确匹配的明确显示“归档”。

## 期末市值

`src/data/companyMarketCaps.json` 单独保存市值、币种、财报截止日、来源 URL 和采集时间，不改变官方财报原始数据。公司页新增可选指标和明细最后一列，默认仍显示营业收入；不增加市盈率。数据随前端发布，页面不请求行情接口。

主来源为 [Stock Analysis 财务比率页](https://stockanalysis.com/stocks/aapl/financials/ratios/?p=quarterly) 的历史 Market Capitalization 字段（页面注明的数据供应商为 S&P Global）。公开窗口通常为最近 20 个季度和 5 个年度。更早时期通过该站的 [Market Cap 历史页](https://stockanalysis.com/stocks/aapl/market-cap/) 与 [CompaniesMarketCap](https://companiesmarketcap.com/apple/marketcap/) 补充，仅收录公开且通过交叉核验的数据；不是公司官方披露指标，也不保证覆盖全部历史。

- 按 `periodEnd` 精确匹配，不按财报发布日或自然季度近似匹配；苹果等非自然季度公司也使用真实财季末。
- 市值是存量，半年/年度取对应期末值，不能像收入一样相加。同比只匹配上一财年同期间。
- 财务比率页未给出实际交易日，不伪造该日期。历史页额外保存 `observationDate`，表示来源记录的参考日，不保证是交易日。仅取精确期末记录、明确的年度/季度收盘记录，或美股财季末为周末时紧邻的前一交易日；不把较早周采样或未来点当成期末数据。
- 保留该市值字段的原始币种，可能不同于营收币种，例如腾讯市值为 HKD，财务报表为 CNY；ADR 公司使用供应商公司级市值，不再叠加另一上市地的相同权益。
- 补充来源必须与原始财务比率页至少 3 个期末重合，偏差中位数不超过 2%、最大偏差不超过 5%；不以此前补数自证。通过后只补缺失日期，不替换原始值。存在明显股本口径差异的来源整组拒绝，而不是放宽阈值。
- 宁德时代、恒瑞医药采用东方财富 `RPT_VALUEANALYSIS_DET` 的完整日频总市值历史，仅限港股上市前（分别为 [2025-05-20](https://www.catl.com/en/news/6451.html)、[2025-05-23](https://www.hengrui.com/media/detail-773.html)）。逐条校验总市值等于收盘价乘总股本，取期末之前最近交易日；港股上市后不把 A 股价格乘总股本当作 A/H 股合计市值。
- 三星采用包含普通股和优先股的来源口径。核验样本：2024 年末普通股 5,969,782,550 股、优先股 822,886,700 股，2024-12-30 收盘价分别为 53,200 和 44,200 韩元，合计 353,964,023,800,000 韩元，与来源一致。股本见[三星上市信息](https://www.samsung.com/global/ir/stock-information/listing-Info/)，历史收盘价由 NAVER `siseJson.naver` 的 005930、005935 日线复核；不重复加计存托凭证。
- 华为未上市；比亚迪、中芯国际、百济神州的多地上市合计口径尚未核验，暂留空，具体原因见 `marketCapUnavailable`。其他公司也可能缺少早期或上市前的记录。缺失不表示零市值，不插值、不沿用相邻期、不用当前股本倒推。

离线维护命令：

```bash
npm run data:companies:market-cap -- --company=apple --write
npm run data:companies:market-cap -- --write
npm run data:companies:market-cap -- --offline --write
npm run data:companies:market-cap:backfill -- --write
npm run data:companies:market-cap:backfill -- --companies=apple,tencent --write
npm run data:companies:market-cap:backfill -- --offline --write
```

脚本串行访问，两项维护命令也应依次运行。原始响应分别缓存于 git 忽略的 `data/company-market-caps/` 和 `data/company-market-cap-history/`；后者生成 `coverage.json`，列出覆盖数、缺失日期和拒绝原因。没有 `--write` 时仅校验。只解析 JSON 或 JavaScript 字面量，不执行上游代码，不读取付费墙后数据。校验来源路径、币种、日期、值和年度/季度同日期一致性。主来源任一所选公司失败时不覆盖正式文件；补历史按来源隔离失败，仅合并核验通过的新增记录。两者保留已保存的较早历史，`--offline` 使用缓存复核。更新后执行 `npm run test:unit`、`npm run data:companies:audit` 和 `npm run build`，审阅差异后再发布；不是 worker 自动更新任务。

## 财报日历

日历与公司数据一样离线维护，日期分为两类：

- `已披露`：报告已经发布，链接指向原始报告或监管申报文件。
- `已确认`：公司、监管机构或交易所已正式公布披露日期，链接指向确认公告。

来源按可信度使用：

- [SEC `submissions` 与 Company Facts](https://www.sec.gov/about/developer-resources) 适合识别美国公司已经提交的 10-Q/10-K 和提取候选指标，但不提供可靠的未来披露安排。
- 港交所[董事会会议日期公告](https://www1.hkexnews.hk/search/predefineddoc.xhtml?predefineddocuments=5)和[巨潮资讯预约披露页](https://www.cninfo.com.cn/new/commonUrl?url=data%2Fyuyuepilu)适合核验港股、A 股正式日程；日期变更时需同步更新。
- 公司投资者关系财务日历适合补充其他市场的正式确认日期。
- [Alpha Vantage](https://www.alphavantage.co/documentation/#earnings-calendar) 和 [Finnhub](https://finnhub.io/docs/api/earnings-calendar) 提供财报日历接口，但需要令牌，且未来日期包含预期数据。它们可用于维护时发现候选，不作为页面运行时依赖，也不能直接标记为官方确认。

当年 SEC 历史事件由维护命令生成到 `src/data/companyReportCalendar.sec.ts`；非美市场已核验报告、最新报告和未来正式日程在 `src/data/companyReportCalendar.ts` 合并并按公司与报告期间去重。日历允许快速切换已有事件月份，但不是全部上市公司的穷举披露清单。没有原始来源链接的预测日期不进入日历，避免用户把估计时间误认为公司公告。
