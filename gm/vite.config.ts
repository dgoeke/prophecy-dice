import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', // Caddy proxies to the IPv4 loopback; 'localhost' may bind ::1 only
    // dev UI proxies to the production service by default; point COLUMN_API
    // at a rehearsal instance (e.g. http://127.0.0.1:7778) to develop there
    proxy: { '/api': process.env.COLUMN_API ?? 'http://127.0.0.1:7777' },
    // reached via Caddy at https://dice-dev.condor.ts.dgoeke.io (tailnet only)
    allowedHosts: ['dice-dev.condor.ts.dgoeke.io'],
  },
  build: { outDir: 'dist' },
  test: { environment: 'node' },
});
