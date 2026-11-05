import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on :3000. Proxying keeps the session cookie first-party,
// the same as production where one server serves both.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: 'dist', sourcemap: false },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
