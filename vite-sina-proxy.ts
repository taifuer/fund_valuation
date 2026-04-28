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
        const codes = new URL(req.url!, 'http://localhost').searchParams.get('codes');
        if (!codes) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing codes parameter' }));
          return;
        }

        const results: Record<string, unknown> = {};
        for (const code of codes.split(',')) {
          try {
            const upstream = await fetch(
              `https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery&fundCode=${code}&pageIndex=1&pageSize=2&_=${Date.now()}`,
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
    },
  };
}
