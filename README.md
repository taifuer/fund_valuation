# 全球资产看板

[![CI](https://github.com/taifuer/fund_valuation/actions/workflows/ci.yml/badge.svg)](https://github.com/taifuer/fund_valuation/actions/workflows/ci.yml)

追踪全球指数、资产、ETF 与 QDII 主动基金，覆盖实时概览、区间收益、回撤风险和按目标日期对齐的基金估算净值。

项目从单页 QDII 估值工具演进为完整数据看板的技术决策、踩坑记录和可复用经验，见 [项目复盘](./docs/PROJECT_RETROSPECTIVE.md)。

## 特性

- **12 个全球指数**：A 股（上证、创业板、沪深300、中证500）、美股（纳斯达克、纳指100、标普500、道琼斯）、亚太（恒生指数、日经225、韩国KOSPI、台湾加权）
- **资产参考**：独立展示黄金、白银、原油和比特币行情，用于辅助观察风险偏好、通胀和流动性环境
- **期货参考**：纳指100、标普500、道琼斯、恒生指数、日经225 在现货闭市且对应期货活跃时，自动显示对应期货并标注“期货 LIVE”
- **市场历史走势**：点击支持的指数/资产卡片查看历史行情，支持今年、1周、1月、3月、半年、1年、3年、5年和全部区间
- **基金管理**：默认 17 只 QDII 主动基金；配置管理令牌后可在当前浏览器添加、删除基金或恢复默认列表
- **双口径估值**：每只基金同时展示最新官方净值、最近待公布净值估算与当前估值日实时参考，目标日期和行情阶段均明确标注
- **持仓穿透**：点击基金卡片展开前十大持仓明细，实时现价、涨跌幅、权重贡献度一目了然
- **动态持仓估算**：新增基金会从东方财富/天天基金抓取最新披露持仓，保存到 SQLite，并在可映射行情时自动参与估算
- **每日净值表**：展开基金卡片可查看近 3 个月每日官方净值和涨跌幅，支持分页浏览
- **历史净值走势**：展开基金卡片可切换查看官方历史单位净值，支持 1周、1月、3月、半年、1年、3年、5年和成立来区间
- **市场状态标签**：各市场指数与持仓股实时标注 LIVE / 延迟 / 已收盘 交易状态，LIVE 标签带呼吸脉冲动画
- **估值排序**：可按待公布估值、实时参考或最新官方净值排序，TOP 3 带有金/银/铜专属标签
- **多市场行情**：覆盖 A 股、港股、美股、日韩台等市场的指数、个股与资产参考行情

## 技术栈

| 层面 | 技术 |
|------|------|
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6 |
| 样式 | CSS Modules |
| 数据源 | 新浪财经（行情）+ 东方财富/天天基金（基金净值与持仓）+ 腾讯港股 + TWSE + Naver Finance + Coin Metrics + ECB |
| 后端 | Flask + SQLite |
| 架构 | React 前端 + Python 本地数据后端（抓取、缓存、持久化） |

## 数据流

```
浏览器 ──→ Vite/Nginx ──→ Flask API ──→ SQLite 当前快照与历史数据
                                      ↑
独立 worker ──→ 新浪/东方财富/TWSE ──┘

Flask Web 请求只读取 SQLite 或持久化上游缓存，不同步等待公开数据源。独立 worker 负责抓取上游、原子发布完整看板快照，并把基金净值、最新持仓和日 K 写入 `data/fund_valuation.db`。浏览器每次轮询都会请求服务器，本地快照仅在接口超时或失败时兜底；上游短暂异常时页面继续使用最近一次有效快照。

worker 按现货 1 分钟、期货 2 分钟、加密资产 5 分钟、闭市 15 分钟的节奏更新行情；开盘前 30 分钟自动提高到每分钟检查。最新基金净值使用独立轻任务，北京时间 16:00–23:30 每 30 分钟检查最新两条，其余时段每 2 小时检查；完整历史校验每天执行一次。行情循环与最新持仓检查、历史回填、备份和清理并行运行，维护任务使用合并队列顺序执行，不会因前一任务繁忙而丢失。Docker 默认保留 7 天行情快照，用于时效诊断和异常回放。
```

基金估算先确定目标净值日：

- **待公布估值**：选择所有相关持仓市场都已完成交易的最近境内估值日，各持仓收盘价与汇率严格冻结在同一目标日期。
- **实时参考**：使用当前境内估值日；已收盘市场使用当日收盘，交易中市场使用当前行情，尚未开盘市场沿用最近收盘，并显示盘前/实时/盘后状态。

计算方式：

```
# 从最新官方净值日累计到目标净值日
股票累计涨跌幅 = 目标日价格 ÷ 官方净值日价格 - 1
汇率累计涨跌幅 = 目标日参考汇率 ÷ 官方净值日参考汇率 - 1

# 单只持仓的 RMB 涨跌（外币持仓并入对应兑 CNY 汇率涨跌）
rmbChange = ((1 + 股票累计涨跌幅) × (1 + 汇率累计涨跌幅) - 1)

# 已披露且行情完整的持仓贡献
持仓贡献 = Σ(持仓权重 × rmbChange)

# 未披露或缺行情权重由基金配置的宽基基准补足
估算累计涨跌 = 持仓贡献 + (1 - 已覆盖权重) × 基准人民币口径涨跌
目标估算净值 = 最新官方净值 × (1 + 估算累计涨跌)
目标日涨跌 = 目标估算净值 ÷ 上一估值日估算净值 - 1
```

> **口径说明**：默认基金按投资方向显式配置纳指100或标普500作为未披露部分的宽基代理；基准历史缺失时才降级为覆盖率归一化。
> worker 会保存待公布估值和实时参考快照，并在对应官方净值披露后记录误差。历史样本达到最低数量、且按时间切分的验证集 MAE 至少改善 10% 时，线性校准才会自动启用；否则始终使用原始模型。
> 展开基金卡片的「持仓」标签页仍展示已披露持仓的原始贡献与行情覆盖率，便于核对。
> 估算仅供参考，不代表基金实际净值。

## 项目结构

```
fund_valuation/
├── index.html
├── package.json
├── Dockerfile
├── docker-compose.yml
├── vite.config.ts                 # Vite 配置
├── config/
│   └── universe.json              # 前后端共用的标的与默认基金配置
├── backend/
│   ├── config.py                  # 共享配置读取与校验
│   ├── contracts.py               # API 契约版本与结构校验
│   ├── db_admin.py                # SQLite 迁移、备份与恢复命令
│   ├── estimation.py              # 日期对齐、基准残差与校准门控
│   ├── fx_history.py              # ECB 历史参考汇率换算与入库
│   ├── observability.py           # 请求指标与结构化日志
│   ├── quotes.py                  # 行情响应结构化
│   ├── server.py                  # Flask API（抓取 + SQLite 缓存）
│   ├── storage.py                 # SQLite 连接与版本化迁移
│   ├── wsgi.py                    # Gunicorn 生产入口
│   ├── worker.py                  # 独立数据刷新、行情快照与清理进程
│   └── backfill.py                # 历史数据增量回填脚本
├── tsconfig.json
└── src/
    ├── types.ts                   # 类型定义
    ├── constants.ts               # 共享 JSON 配置的类型化导出
    ├── api.ts                     # 数据获取 & 多市场解析
    ├── hooks/
    │   └── useQuotes.ts           # 行情 + 净值 + 估算 hook
    ├── components/
    │   ├── Header.tsx             # 标题栏（实时时钟）
    │   ├── IndexCards.tsx         # 12 个指数卡片面板
    │   ├── MarketHistoryModal.tsx # 指数/资产历史走势弹窗
    │   ├── FundCard.tsx           # 基金卡片（双净值 + 展开）
    │   ├── FundHistoryChart.tsx   # 官方历史净值走势
    │   ├── FundNavTable.tsx       # 每日官方净值表
    │   └── HoldingsTable.tsx      # 持仓明细表
    ├── marketHours.ts             # 各市场交易时段（北京时间）
    ├── App.tsx                    # 主应用（排序逻辑）
    ├── App.module.css
    ├── index.css
    └── main.tsx
```

## 快速开始

```bash
# 1. 克隆项目
git clone <repo-url>
cd fund_valuation

# 2. 安装依赖
npm install
npm run backend:setup

# 3. 启动 Flask 数据后端
npm run backend

# 4. 另开终端启动独立数据刷新进程
npm run backend:worker

# 5. 首次部署时增量回填基金净值和指数/资产日 K
npm run backend:backfill

# 6. 另开终端启动前端开发服务器
npm run dev

# 7. 浏览器打开
open http://localhost:5173
```

刷新 worker 使用 SQLite 租约避免多实例重复抓取，每分钟检查任务计划：现货开盘时行情每 60 秒更新，期货每 2 分钟更新，仅加密资产交易时每 5 分钟更新，全部闭市后降为 15 分钟；最新基金净值在北京时间 16:00–23:30 每 30 分钟读取每只基金最新两条，其余时段每 2 小时检查，最近 80 条及完整历史校验每天执行一次。市场日线仅在对应市场完成当日交易且本地日期落后时更新，未到收盘时间不会重复抓取。最新季度持仓每 24 小时批量检查一次，基金规模与费率资料每周检查一次。worker 每天维护当前持仓日线、比特币日线与 ECB 参考汇率，首次启动会自动补齐近 6 年汇率，作为跨多个净值日累计估算的本地基准；每次发布完整行情快照后同步计算并保存基金估值快照。页面请求本身不会补抓这些历史数据。发现新季度持仓时会同步更新对应基金资料，新持仓入库后会自动加入行情快照和估值计算。`FUND_VALUATION_REFRESH_INTERVAL` 用于设置市场历史维护周期下限，`FUND_VALUATION_FX_HISTORY_YEARS` 用于设置汇率历史覆盖年数，`FUND_VALUATION_SNAPSHOT_RETENTION_DAYS` 用于调整行情快照保留天数。核心看板请求不会因快照过期而同步抓取上游；首次查看尚未入库的自定义基金资料时，资料接口会按需补取一次。内置刷新默认关闭，仅兼容旧部署时可显式设置 `FUND_VALUATION_BACKGROUND_REFRESH=1`。

公开状态接口 `/api/status` 只返回汇总后的刷新状态，`/api/meta` 返回当前 API 契约版本和基金管理模式。内部诊断页位于 `/diagnostics`，对应接口 `/api/diagnostics/quotes` 会返回快照缺失、延迟、兜底、请求耗时、缓存命中以及基金净值、季度持仓、市场日线和汇率覆盖度；必须设置 `FUND_VALUATION_DIAGNOSTICS_TOKEN`，并在诊断页输入同值令牌后才能查询。每个 API 响应都包含 `X-Request-ID`、`X-Elapsed-ms` 和 `X-API-Schema-Version` 响应头，慢请求与未处理异常使用 JSON 结构化日志输出。

历史数据回填脚本默认读取 `config/universe.json` 中配置的基金、指数和资产，写入 `data/fund_valuation.db`。常用参数：

```bash
npm run backend:backfill                         # 增量更新全部可配置历史数据
npm run backend:backfill -- --full               # 从第一页持续拉取到上限，用于初始化或修复缺口
npm run backend:backfill -- --skip-markets       # 只更新基金官方历史净值
npm run backend:backfill -- --skip-funds         # 只更新指数/资产日 K
npm run backend:backfill -- --use-cache          # 优先复用 response_cache 中已有上游响应
npm run backend:backfill -- --fund-code 118001   # 额外回填自定义基金代码
npm run backend:backfill -- --fund-codes 118001,457001
npm run backend:backfill -- --holdings-years 5   # 可选：归档近 5 年季度持仓
npm run backend:backfill -- --fx-years 6         # 可选：归档近 6 年 ECB 参考汇率
npm run backend:backfill -- --skip-fx            # 显式跳过历史汇率更新
```

SQLite 会在后端、worker 或回填脚本启动时自动执行向前兼容的版本化迁移。常用维护命令：

```bash
npm run backend:db -- status
npm run backend:db -- migrate
npm run backend:db -- backup
npm run backend:db -- restore data/backups/fund_valuation-YYYYMMDD-HHMMSS.db --confirm RESTORE
```

恢复前会自动备份当前数据库。生产恢复时仍建议先停止 backend 和 worker，完成后再启动服务。

## 构建部署

```bash
npm run build     # 产物输出到 dist/
npm run preview   # 预览生产构建
```

> 开发环境下，Vite 会把 `/api/*` 代理到 `http://127.0.0.1:8000`。生产部署时，可以让前端同域反代到 Python 后端，或设置 `VITE_API_BASE_URL` 指向后端地址后再构建。

项目提供 Nginx + Gunicorn + 独立刷新 worker 的容器部署：

```bash
cp .env.example .env
# 编辑 .env，至少替换诊断令牌
docker compose up --build -d
```

默认访问 `http://localhost:8080`。`/api/health` 用于进程存活检查，`/api/ready` 同时检查 SQLite 是否可用。生产环境应通过 `.env` 或部署平台注入诊断令牌，不要写入仓库。基金管理默认关闭；同时设置 `FUND_VALUATION_ENABLE_FUND_MANAGEMENT=1` 和独立的 `FUND_VALUATION_FUND_MANAGEMENT_TOKEN` 后，基金页显示管理入口，用户输入令牌后可在当前浏览器维护基金列表。非默认基金请求由后端校验 `X-Fund-Management-Token`，关闭总开关后仍会被拒绝。`FUND_VALUATION_BAIDU_ANALYTICS_ID` 可选配置百度统计站点 ID。反向代理部署可将 `FUND_VALUATION_HTTP_HOST` 设为 `127.0.0.1`，国内服务器也可通过 `FUND_VALUATION_NPM_REGISTRY` 和 `FUND_VALUATION_PIP_INDEX_URL` 使用可信软件源镜像。

Docker Worker 默认每天创建一次经过完整性校验的 SQLite 在线备份，保留 7 天且最多保留最新 3 份。备份通过 `FUND_VALUATION_BACKUP_HOST_DIR` 写入宿主机目录，默认是项目下的 `data/backups`；生产环境应改为 Web 根目录之外、可被异地备份任务读取的位置，例如 `/www/backup/database/fund-valuation`。可通过 `FUND_VALUATION_AUTO_BACKUP`、`FUND_VALUATION_BACKUP_INTERVAL_HOURS`、`FUND_VALUATION_BACKUP_RETENTION_DAYS` 和 `FUND_VALUATION_BACKUP_MAX_FILES` 调整；非 Docker 本地运行默认不自动备份。行情快照、上游响应缓存和原始响应均为可再生成数据，Docker 默认分别保留 7、14、7 天；大型响应缓存会透明压缩，Worker 每天清理并执行非阻塞 WAL checkpoint 与 `PRAGMA optimize`，不会自动删除历史净值、日线或持仓数据。

容器内数据库维护可使用工具 profile：

```bash
docker compose --profile tools run --rm db-tools python -m backend.db_admin backup
docker compose --profile tools run --rm db-tools python -m backend.db_admin status
docker compose --profile tools run --rm db-tools python -m backend.db_admin optimize
```

`optimize` 默认只做在线安全维护。若需要将清理后的空闲页归还给文件系统，应先停止 backend 和 worker，再执行 `python -m backend.db_admin optimize --vacuum`；`VACUUM` 会重建数据库文件，不应在业务请求期间运行。

## 测试

```bash
npm test          # Python 后端测试 + Vitest 组件/逻辑测试 + 兼容逻辑测试
npm run test:e2e  # Playwright 桌面端与移动端路由冒烟测试
npm run build     # TypeScript 与生产构建校验
```

`.github/workflows/ci.yml` 会在 `main`、`dev` 的 push 和 pull request 上并行执行上述后端、前端和浏览器测试，并构建 Docker 镜像、启动临时 Compose 环境、检查健康/就绪/API/SPA 路由和数据库完整性，结束后删除临时容器与数据卷。整个过程不需要仓库 Secrets，也不会连接生产服务器。

## 演示

### 概览

![概览](./demo/overview.png)

### 基金

![基金](./demo/fund.png)

### 收益

![收益](./demo/rank.png)

### 风险

![风险](./demo/risk.png)

### 详情

#### 股票走势

![股票走势](./demo/stock_history.png)

#### 基金走势

![基金走势](./demo/fund_history.png)

#### 基金净值

![基金净值](./demo/fund_value.png)

## 数据说明

- **实时行情**：来自新浪财经，A 股为交易时段实时，美股为北京时间晚间实时。港股和亚太指数非交易时段显示前收盘价；纳指100、标普500、道琼斯、恒生指数和日经225在现货闭市时可显示对应期货参考行情；资产分组展示黄金、白银、原油和比特币行情
- **历史行情**：指数、资产和 ETF 走势使用日 K 数据；A 股指数、美股指数来自新浪日 K，恒生指数与恒生科技使用腾讯港股指数现货日线，日经225使用对应期货日 K，台湾加权来自台湾证券交易所（TWSE）官方月度历史（使用无重定向的 `www.twse.com.tw` 域名），韩国 KOSPI 来自 Naver Finance 日线并以东方财富作为兜底，黄金、白银和原油来自新浪外盘期货日 K；比特币历史使用 Coin Metrics `PriceUSD` UTC 日终美元参考价格，首次无本地数据且主源不可用时可由 Binance `BTCUSDT` 日线初始化
- **市场状态**：各市场根据交易所本地时区、周末和 2026 年主要休市日判定 LIVE / 延迟 / 已收盘
- **最新官方净值**：来自天天基金/东方财富；QDII 披露可能晚于前一个交易日，具体日期以卡片显示为准
- **最新净值涨跌幅**：来自东方财富历史净值数据，为最新官方净值相较上一条净值的日间涨跌
- **待公布估值/实时参考**：均基于最新有效季度披露持仓并合并兑 CNY 汇率；前者只使用同一目标日期的已完成行情，后者才纳入当前交易阶段。未披露部分优先使用基金配置的宽基基准，基准不可用时才按已覆盖权重归一化。worker 定期检查最新持仓，只接受正式季末报告日，入库后自动用于估算。
- **持仓数据**：基于基金最新季报/年报披露的前十大持仓，权重为近似值，可能因基金经理调仓而与实际有偏差。普通基金直接使用披露持仓，ETF 联接基金按目标 ETF 穿透，FOF 按披露的基金投资组合估算；美股、港股、A 股映射到新浪行情，日股和韩股映射到 Naver Finance 行情。

## 计算方式

- **日期对齐**：最新官方净值日、待公布目标日和实时参考目标日分别保存；同一待公布估值内的股票、基准和汇率不会跨目标日期混用。
- **人民币口径**：外币持仓按 `人民币口径涨跌 = (1 + 持仓累计涨跌) × (1 + 汇率累计涨跌) - 1` 合并。
- **残差模型**：`估算累计涨跌 = 已披露持仓贡献 + 剩余权重 × 宽基基准人民币涨跌`；宽基不可用时使用 `已披露持仓贡献 / 已覆盖权重` 作为降级结果。
- **误差校准**：估值快照在官方净值披露后自动关联实际涨跌；只有不少于 30 个样本且时间外验证 MAE 至少改善 10% 时才应用受限线性校准，防止小样本过拟合。

## 数据局限

- **公开接口稳定性**：本项目使用公开行情接口，接口格式、访问频率、跨域策略和可用性可能变化；Flask 后端会缓存原始响应和结构化历史数据，历史接口优先读 SQLite，但仍不能保证上游长期稳定。
- **实时行情延迟**：新浪财经行情可能存在延迟、暂停更新或字段缺失。非交易时段通常显示最近收盘价，美股盘前/盘后行情只在接口返回有效扩展交易价格时参与展示和估算。
- **期货替代现货**：现货闭市时展示的期货价格只作为方向参考。期货合约与现货指数存在基差、汇率、利率、分红和换月影响，不能等同于现货指数涨跌。
- **历史 K 线覆盖**：不同市场历史数据长度不一致。A 股新浪日 K 当前可获取的条数有限，因此 5年/全部区间可能不足完整 5 年；恒生指数使用腾讯现货历史，日经225仍使用对应期货历史而非现货指数历史。台湾加权使用 TWSE 官方数据；韩国 KOSPI 保存近 10 年 Naver Finance 日线，Naver 并非承诺稳定性的正式开放 API，异常时会使用东方财富历史日 K 兜底。Coin Metrics 社区数据适用于非商业用途，其他用途需自行确认其许可条款。
- **境外持仓行情**：港股持仓日线优先使用新浪，接口不支持对应代码时自动切换至腾讯前复权日线；日股和韩股使用 Naver Finance 公共接口，当前生产服务器可直接访问，日本行情通常延迟约 15 分钟，个股历史单次更新最近 60 个交易日。公开接口均没有稳定性承诺，上游异常时会保留最近一次有效数据，不会用错误市场代码替代。
- **基金净值时效**：官方净值以基金公司披露为准，QDII 基金通常存在 T+1/T+2 披露延迟；节假日、境内外市场休市差异会影响“最近一个已公布净值”的日期。
- **估算覆盖范围**：估算主要基于已披露的前十大持仓、宽基代理和可获取行情，无法准确覆盖完整组合、现金、衍生品、基金申赎、费用、基金实际估值时点和盘中调仓。新增基金若没有显式基准且持仓无法映射到可访问行情源，结果会降级为覆盖率归一化，参考价值更低。
- **持仓滞后**：持仓来自定期报告，披露频率低于实际调仓频率，权重会随市场涨跌和基金经理操作变化，估算结果只适合观察方向，不适合作为交易依据。

## License

MIT
