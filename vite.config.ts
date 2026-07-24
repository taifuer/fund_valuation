import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'FUND_VALUATION_');
  return {
    plugins: [react()],
    define: {
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
