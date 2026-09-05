# 架构说明

## 运行时拓扑

```text
浏览器 -> Nginx -> React SPA
               -> Flask API -> SQLite
                                  ^
独立 worker -> 公开数据源 ---------+
```

Flask Web 请求只读取 SQLite 或持久化快照，不在请求过程中同步抓取公开接口。独立 worker 负责行情、基金净值、持仓、基金资料和历史数据的刷新，校验完整后原子发布看板快照。公司经营数据随前端版本发布，不进入运行时抓取链路。

这种设计把上游延迟与用户请求隔离：多位用户读取同一份服务器快照，上游异常时页面继续使用最近一次有效数据，冷启动也不会触发每位用户重复抓取。

## 数据刷新

- 现货交易时段通常每 1 分钟更新，开盘前 30 分钟提高检查频率
- 活跃期货通常每 2 分钟更新，加密资产每 5 分钟更新
- 全部相关市场闭市后，行情检查降低为约 15 分钟一次
- 最新基金净值在北京时间 16:00–23:30 每 30 分钟检查，其余时段每 2 小时检查
- 市场日线至少每 30 分钟检查；基金完整历史、历史汇率和数据库维护按日执行
- 最新季度持仓每天检查，基金规模、费率等低频资料每周检查

刷新任务使用 SQLite 租约避免多 worker 重复抓取；维护任务进入合并队列顺序执行，避免重任务堆积。行情快照、原始响应和上游缓存按保留周期自动清理，官方净值、日线和持仓等业务历史不会自动删除。

## 前端边界

- `src/App.tsx`：全局路由、页面装配和共享市场状态
- `src/hooks/useQuotes.ts`：基金卡片轻量快照；估值只采用服务端结果
- `src/hooks/usePageData.ts`：概览、收益与独立汇率数据协调
- `src/components/`：市场卡片、基金详情、收益风险、公司经营和诊断页面
- `src/data/companies/*.ts`：按公司拆分的版本化经营数据与原始披露元数据
- `src/data/companyFundamentals.ts`：数据集聚合、口径说明与半年派生逻辑
- `src/data/companyReportCalendar.ts`：已披露及官方确认的财报日程
- `src/api.ts`、`src/http.ts`：API 契约、请求截止时间和响应解析
- `src/marketHours.ts`：按北京时间统一的市场时段与状态逻辑

收益、风险、公司、关于和基金详情子模块按需加载，减少首次访问的 JavaScript 体积。页面路由保留筛选参数，刷新或分享链接后可恢复当前视图。

基金页首屏使用 `/api/fundestimates?view=cards`，一次读取官方净值、服务端估值、汇率和市场状态，不包含逐项持仓行情。展开持仓后才读取该基金的完整估值快照，资料与走势继续按标签懒加载。快照缺失时不触发请求内计算，等待 worker 发布。正常重复快照直接返回，不进行额外 15 秒等待或强制重试。

扩展持仓表默认只渲染前 20 项，可展开全部；展示截断不影响估算使用的持仓。未进入服务端日期对齐估算的行不在浏览器另外推算贡献。

浏览器请求超时覆盖响应体读取。历史图表缓存 5 分钟后再次访问会后台刷新；页面切换保留已加载卡片和各页筛选，加载提示预留高度，收益/风险表首次加载使用等高骨架行。

基金和市场走势图按容器宽度重算坐标，坐标字号保持固定；窄屏减少重叠刻度，不缩小整张图。刷新失败保留已有图表并标注缓存状态。

## 后端边界

- `backend/server.py`：Flask API 与鉴权入口
- `backend/worker.py`：数据刷新、快照发布和维护调度
- `backend/storage.py`：SQLite 连接、迁移和持久化
- `backend/estimation.py`：日期对齐、残差代理与校准门控
- `backend/performance.py`：历史收益、分红拆分调整与风险指标
- `backend/fund_disclosures.py`：基金净值趋势、累计净值和资产配置的纯数据解析
- `backend/backfill.py`：基金净值、市场日线、汇率和持仓历史回填
- `backend/db_admin.py`：状态检查、备份、恢复和在线优化
- `backend/contracts.py`：API Schema 版本与结构校验

前后端共用的标的与默认基金配置位于 `config/universe.json`，避免行情、历史和估值使用不同代码映射。

## API 与可观测性

核心页面使用聚合快照接口，基金详情和历史数据按需加载。主要接口包括：

- `/api/overview`、`/api/dashboard`：概览快照
- `/api/fundnav`、`/api/fundestimates`、`/api/fundreturns`：基金净值与估值
- `/api/markethistory`、`/api/marketreturns`：市场历史与区间表现
- `/api/fundhistory`、`/api/fundholdings`：基金历史与持仓
- `/api/status`、`/api/meta`：公开状态和 API 契约信息
- `/api/health`、`/api/ready`：进程存活与数据库就绪检查

内部诊断位于 `/diagnostics`，需要 `FUND_VALUATION_DIAGNOSTICS_TOKEN`。API 响应包含 `X-Request-ID`、`X-Elapsed-ms` 和 `X-API-Schema-Version`，慢请求与未处理异常写入结构化日志。
