import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // fs.allow lets the dev-only inspector open model files that live next to the project (../agents_Details)
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    fs: { allow: ['..'] },
    // the scanner runs next to the site in production; in development it answers on :8000
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false } },
  },
  // `npm run preview` serves the production build with the same Content-Security-Policy as the scanner's static server (server/guardscan/api.py),
  // so a policy that would break the page shows up here before it reaches Cloud Run.
  preview: {
    host: '127.0.0.1',
    port: 4173,
    headers: {
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
