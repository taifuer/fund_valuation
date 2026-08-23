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
