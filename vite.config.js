import { defineConfig } from 'vite';
export default defineConfig({
  root: 'frontend',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:3000', '/ws': { target: 'ws://127.0.0.1:3000', ws: true, rewriteWsOrigin: true } } },
});
