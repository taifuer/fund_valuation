import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const localHosts = ['127.0.0.1', 'localhost'];
const noProxy = new Set(
  `${process.env.NO_PROXY ?? ''},${process.env.no_proxy ?? ''}`
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
localHosts.forEach((host) => noProxy.add(host));
process.env.NO_PROXY = [...noProxy].join(',');
process.env.no_proxy = process.env.NO_PROXY;

const e2eDataDir = resolve('test-results/backend-data');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `FUND_VALUATION_PREWARM=0 FUND_VALUATION_DATA_DIR=${e2eDataDir} npm run backend`,
      url: 'http://127.0.0.1:8000/api/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'VITE_API_BASE_URL=http://127.0.0.1:8000 npm run build && python3 scripts/serve_spa.py --host 127.0.0.1 --port 5173',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
  ],
});
