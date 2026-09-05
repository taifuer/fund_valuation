# 部署运维

## 本地开发

要求 Node.js、npm、Python 3 和 SQLite。首次安装：

```bash
git clone https://github.com/taifuer/fund_valuation.git
cd fund_valuation
npm install
npm run backend:setup
```

分别在三个终端启动：

```bash
npm run backend         # Flask API，默认 http://127.0.0.1:8000
npm run backend:worker  # 独立数据刷新进程
npm run dev             # Vite，默认 http://localhost:5173
```

Vite 将 `/api/*` 代理至本地 Flask。首次运行建议执行一次 `npm run backend:backfill`。

## 历史回填

回填脚本默认读取 `config/universe.json`，增量写入 `data/fund_valuation.db`：

```bash
npm run backend:backfill
npm run backend:backfill -- --full
npm run backend:backfill -- --skip-markets
npm run backend:backfill -- --skip-funds
npm run backend:backfill -- --use-cache
npm run backend:backfill -- --fund-code 118001
npm run backend:backfill -- --fund-codes 118001,457001
npm run backend:backfill -- --holdings-years 5
npm run backend:backfill -- --fx-years 6
npm run backend:backfill -- --skip-fx
```

页面请求不会补抓完整历史。新增基金的初次资料可按需获取，之后由 worker 纳入净值、持仓和行情维护。

## Docker Compose

```bash
cp .env.example .env
# 至少替换诊断令牌
docker compose up --build -d
```

默认访问 `http://localhost:8080`。服务包括 Nginx 前端、Gunicorn 后端和独立 worker；SQLite 与备份目录挂载到宿主机。生产环境建议将 HTTP 绑定到 `127.0.0.1`，再由外层反向代理提供 HTTPS。

重要配置：

- `FUND_VALUATION_DIAGNOSTICS_TOKEN`：内部诊断令牌
- `FUND_VALUATION_ENABLE_FUND_MANAGEMENT`：是否开放基金管理入口
- `FUND_VALUATION_FUND_MANAGEMENT_TOKEN`：基金管理独立令牌
- `FUND_VALUATION_HTTP_HOST`：Compose 对外绑定地址
- `FUND_VALUATION_BACKUP_HOST_DIR`：宿主机备份目录
- `FUND_VALUATION_SNAPSHOT_RETENTION_DAYS`：行情快照保留天数
- `FUND_VALUATION_FX_HISTORY_YEARS`：历史汇率覆盖年数
- `FUND_VALUATION_BAIDU_ANALYTICS_ID`：可选的百度统计站点 ID

完整默认值和说明以 `.env.example` 为准。不要把令牌写入仓库。

## 数据库维护

SQLite 在后端、worker 或回填脚本启动时自动执行向前兼容迁移：

```bash
npm run backend:db -- status
npm run backend:db -- migrate
npm run backend:db -- backup
npm run backend:db -- restore data/backups/fund_valuation-YYYYMMDD-HHMMSS.db --confirm RESTORE
```

Docker 环境可使用工具 profile：

```bash
docker compose --profile tools run --rm db-tools python -m backend.db_admin status
docker compose --profile tools run --rm db-tools python -m backend.db_admin backup
docker compose --profile tools run --rm db-tools python -m backend.db_admin optimize
```

`optimize` 只执行在线维护。`--vacuum` 会重建数据库文件，应先停止 backend 与 worker，并确认已有可恢复备份后再执行。

## 备份与清理

Docker worker 默认每天创建一次通过完整性校验的 SQLite 备份，保留 7 天且最多 3 份。生产环境应把 `FUND_VALUATION_BACKUP_HOST_DIR` 设置到 Web 根目录之外，并由独立任务同步到异地或对象存储。

行情快照、原始响应和响应缓存属于可再生成数据，会按配置周期清理并执行非阻塞 WAL checkpoint 与 `PRAGMA optimize`；基金净值、市场日线和季度持仓不会被自动删除。恢复数据库前会自动备份当前文件，生产恢复仍建议先停止 backend 和 worker。

## 构建与测试

```bash
npm test
npm run test:e2e
npm run build
npm run preview
```

CI 在 `main`、`dev` 的 push 和 pull request 上执行后端、前端和浏览器测试，并构建 Docker 镜像、启动临时 Compose 环境、验证健康检查、API、SPA 路由和数据库完整性。CI 不连接生产服务器。

## 串行更新与恢复验收

已经部署过的环境可以先预演，确认后加 `--execute`：

```bash
.venv/bin/python -m backend.deployment --project fund_valuation --commit <完整提交SHA> --url http://127.0.0.1:8080
```

执行时要求工作区干净且提交匹配；复用现有 `.env`，依次构建四个镜像，保存旧镜像引用，停止本项目两个写进程，备份并验证隔离恢复，再迁移、启动、检查 API 和页面路由。脚本不拉取代码、不操作其他 Compose 项目、不清理全局 Docker 缓存，也不会自动恢复线上数据库。首次部署仍使用前面的 Compose 命令。

恢复清单位于 `data/deployments/`，不含令牌。兼容数据库版本时，可用 `--rollback data/deployments/<时间>.json --execute` 回退镜像；数据库版本高于旧镜像支持范围时会拒绝回退，必须先人工评估是否恢复备份及期间新增数据。失败后按清单检查阶段，不自动覆盖数据。

独立验证现有备份，不接触运行中的数据库：

```bash
npm run backend:db -- verify-backup /path/to/backup.db
```

命令在临时目录恢复、迁移并检查完整性和历史行数，然后删除临时副本。CI 也执行这项验收。生产仍需浏览器检查数据、console 和移动端交互，HTTP 验收不能替代这些检查。

## 内部监测与财报检查

受令牌保护的运行诊断增加逐路由 P95 和后台任务最近成功、失败、耗时。P95 是当前 Gunicorn 进程每条路由最近 256 个样本，不是跨进程全站统计；任务状态保存在共享数据库。行情刷新成功不会抹去历史维护任务的失败记录。运行中标记也可能是进程中断后遗留，需结合 worker 心跳判断。

[估值质量说明](VALUATION_QUALITY.md) 记录持仓识别、价格防护和内部观察口径。

```bash
npm run data:companies:check -- --all --output=data/company-review.json
npm run data:companies:check -- --companies=samsung,tencent --output=data/company-review.json
```

检查器串行检查 SEC 和非美官方归档，输出更新候选与历史逐期链接，失败不会改动离线数据。候选必须人工核对报告期、币种、合并范围和披露日期后才能录入来源；数字不会自动覆盖。

`Company report review` 工作流支持手动执行，计划每周一、四检查 `dev` 数据并保存 14 天 artifact，不依赖生产服务器、不提交数据。GitHub 定时触发要求该工作流文件存在于仓库默认分支；仅推送到 `dev` 不会自动启用日程。上游检查与主 CI 分开，不因财报网站暂时受限阻断部署。
