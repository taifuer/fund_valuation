import type { Plugin, ViteDevServer } from 'vite';

export default function dataProxy(): Plugin {
  return {
    name: 'data-proxy',
    configureServer(server: ViteDevServer) {
      // Sina Finance (stocks + indices, all markets)
      server.middlewares.use('/api/sina', async (req, res) => {
        const list = new URL(req.url!, 'http://localhost').searchParams.get('list');
        if (!list) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing list parameter' }));
          return;
        }
        try {
          const upstream = await fetch(`https://hq.sinajs.cn/list=${list}`, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              Referer: 'https://finance.sina.com.cn/',
            },
          });
          const text = await upstream.text();
          res.writeHead(upstream.status, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=30',
          });
          res.end(text);
        } catch {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Upstream fetch failed' }));
        }
      });

      // East Money fund NAV
      server.middlewares.use('/api/fundnav', async (req, res) => {
        const codes = new URL(req.url!, 'http://localhost').searchParams.get('codes');
        if (!codes) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing codes parameter' }));
          return;
        }

        const results: Record<string, unknown> = {};
        for (const code of codes.split(',')) {
          try {
            const upstream = await fetch(`https://fundgz.1234567.com.cn/js/${code}.js`, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Referer: 'https://fund.eastmoney.com/',
              },
            });
            const text = await upstream.text();
            const match = text.match(/^jsonpgz\((.+)\);?\s*$/);
            if (match) {
              results[code] = JSON.parse(match[1]);
            }
          } catch {
            // skip
          }
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60',
        });
        res.end(JSON.stringify(results));
      });

      // East Money fund NAV history (last 2 records)
      server.middlewares.use('/api/fundhistory', async (req, res) => {
        const params = new URL(req.url!, 'http://localhost').searchParams;
        const codes = params.get('codes');
        if (!codes) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing codes parameter' }));
          return;
        }
        const requestedPageSize = Number(params.get('pageSize') ?? '2');
        const pageSize = Number.isFinite(requestedPageSize)
          ? Math.min(Math.max(Math.floor(requestedPageSize), 2), 200)
          : 2;
        const requestedPageIndex = Number(params.get('pageIndex') ?? '1');
        const pageIndex = Number.isFinite(requestedPageIndex)
          ? Math.max(Math.floor(requestedPageIndex), 1)
          : 1;

        const results: Record<string, unknown> = {};
        for (const code of codes.split(',')) {
          try {
            const upstream = await fetch(
              `https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery&fundCode=${code}&pageIndex=${pageIndex}&pageSize=${pageSize}&_=${Date.now()}`,
              {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  Referer: 'https://fund.eastmoney.com/',
                },
              },
            );
            const text = await upstream.text();
            const match = text.match(/jQuery\((.+)\)/);
            if (match) {
              const data = JSON.parse(match[1]);
              if (data.Data?.LSJZList) {
                results[code] = data.Data.LSJZList;
              }
            }
          } catch {
            // skip
          }
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=120',
        });
        res.end(JSON.stringify(results));
      });

      // Market history for supported indices and global futures
      server.middlewares.use('/api/markethistory', async (req, res) => {
        const params = new URL(req.url!, 'http://localhost').searchParams;
        const source = params.get('source');
        const symbol = params.get('symbol');
        if (!source || !symbol) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing source or symbol parameter' }));
          return;
        }

        try {
          let upstream: Response;
          if (source === 'sina-cn') {
            upstream = await fetch(
              `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketData.getKLineData?symbol=${encodeURIComponent(symbol)}&scale=240&ma=no&datalen=1023`,
              {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  Referer: 'https://finance.sina.com.cn/',
                },
              },
            );
          } else if (source === 'sina-us') {
            upstream = await fetch(
              `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_=/US_MinKService.getDailyK?symbol=${encodeURIComponent(symbol)}`,
              {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  Referer: 'https://finance.sina.com.cn/stock/usstock/',
                },
              },
            );
          } else if (source === 'sina-futures') {
            upstream = await fetch(
              `https://stock2.finance.sina.com.cn/futures/api/json.php/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${encodeURIComponent(symbol)}`,
              {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  Referer: 'https://finance.sina.com.cn/futures/',
                },
              },
            );
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unsupported source' }));
            return;
          }

          const text = await upstream.text();
          res.writeHead(upstream.status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300',
          });
          res.end(text);
        } catch {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Upstream fetch failed' }));
        }
      });

      // Market intraday/minute line for supported indices and global futures
      server.middlewares.use('/api/marketintraday', async (req, res) => {
        const params = new URL(req.url!, 'http://localhost').searchParams;
        const source = params.get('source');
        const symbol = params.get('symbol');
        if (!source || !symbol) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing source or symbol parameter' }));
          return;
        }

        try {
          let upstream: Response;
          if (source === 'sina-cn') {
            upstream = await fetch(
              `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketData.getKLineData?symbol=${encodeURIComponent(symbol)}&scale=1&ma=no&datalen=300`,
              {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  Referer: 'https://finance.sina.com.cn/',
                },
              },
            );
          } else if (source === 'sina-us') {
            upstream = await fetch(
              `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_=/US_MinKService.getMinK?symbol=${encodeURIComponent(symbol)}&type=1`,
              {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  Referer: 'https://finance.sina.com.cn/stock/usstock/',
                },
              },
            );
          } else if (source === 'sina-futures') {
            upstream = await fetch(
              `https://stock2.finance.sina.com.cn/futures/api/json.php/GlobalFuturesService.getGlobalFuturesMinLine?symbol=${encodeURIComponent(symbol)}`,
              {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  Referer: 'https://finance.sina.com.cn/futures/',
                },
              },
            );
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unsupported source' }));
            return;
          }

          const text = await upstream.text();
          res.writeHead(upstream.status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=30',
          });
          res.end(text);
        } catch {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Upstream fetch failed' }));
        }
      });
    },
  };
}
