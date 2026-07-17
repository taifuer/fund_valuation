import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function enabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'FUND_VALUATION_');
  return {
    plugins: [react()],
    define: {
      __FUND_MANAGEMENT_ENABLED__: JSON.stringify(enabled(env.FUND_VALUATION_ENABLE_FUND_MANAGEMENT, true)),
      __BAIDU_ANALYTICS_ID__: JSON.stringify(env.FUND_VALUATION_BAIDU_ANALYTICS_ID ?? ''),
    },
    server: {
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
      },
    },
  };
});
