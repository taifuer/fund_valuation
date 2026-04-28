import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import sinaProxy from './vite-sina-proxy';

export default defineConfig({
  plugins: [react(), sinaProxy()],
});
