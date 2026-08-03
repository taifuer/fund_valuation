import styles from './AboutPage.module.css';

const UPDATES = [
  {
    date: '2026年8月',
    title: '完善 QDII 估算与持仓覆盖',
    description: '明确待公布估值、实时参考和已披露净值的日期口径，更新基金季度持仓，并补充日本、韩国个股行情支持。',
  },
  {
    date: '2026年7月',
    title: '提升数据稳定性与使用体验',
    description: '将行情、历史和基金数据改为后台持续更新，优化移动端表格、基金详情、管理权限和运行诊断。',
  },
  {
    date: '2026年6月',
    title: '形成独立的数据分析页面',
    description: '新增基金、收益和风险页面，支持可分享路由、区间收益、最大回撤、收益回撤比和胜率等指标。',
  },
  {
    date: '2026年5月',
    title: '接入历史数据与本地服务',
    description: '加入官方基金净值、市场历史走势和详情查看，并使用 Flask 与 SQLite 管理数据抓取、缓存和增量更新。',
  },
] as const;

export default function AboutPage() {
  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <h2>关于本站</h2>
      </header>

      <div className={styles.content}>
        <section className={styles.section} aria-labelledby="about-introduction">
          <h3 id="about-introduction">本站简介</h3>
          <p>
            全球资产看板聚合主要市场指数、资产、ETF 和 QDII 基金公开数据，提供市场概览、官方净值、持仓估算、区间收益与风险指标，帮助快速了解不同市场和基金的近期表现。
          </p>
          <p>
            行情主要来自新浪财经、腾讯财经、台湾证券交易所、Naver Finance 和 Coin Metrics，历史参考汇率来自欧洲中央银行；基金净值、资料及持仓主要来自天天基金、东方财富等公开接口。不同数据源可能存在延迟、缺失或误差；基金估算基于已披露持仓、行情与汇率计算，不代表基金公司正式净值。基金净值以基金管理人正式披露为准，所有数据仅供参考，不构成投资建议。
          </p>
          <dl className={styles.details}>
            <div>
              <dt>项目源码</dt>
              <dd><a href="https://github.com/taifuer/fund_valuation" target="_blank" rel="noreferrer">GitHub · fund_valuation</a></dd>
            </div>
            <div>
              <dt>问题反馈</dt>
              <dd><a href="mailto:taifu@taifua.com">taifu@taifua.com</a></dd>
            </div>
            <div>
              <dt>隐私说明</dt>
              <dd>本站不提供账户体系；部署时可能启用访问统计，仅用于了解站点运行和使用情况。</dd>
            </div>
          </dl>
        </section>

        <section className={styles.section} aria-labelledby="update-history">
          <h3 id="update-history">更新记录</h3>
          <ol className={styles.timeline}>
            {UPDATES.map((update) => (
              <li key={update.date}>
                <time>{update.date}</time>
                <div>
                  <h4>{update.title}</h4>
                  <p>{update.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
