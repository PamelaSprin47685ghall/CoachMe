import { resolve } from 'node:path';
import { defineConfig, normalizePath } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Development only: forward fixed application routes to our own Bun server.
// AI credentials and upstream selection are never handled by Vite or the browser.
const target = process.env.MARGINTALK_API_TARGET || 'http://127.0.0.1:3000';
const privatePaths = [
  process.env.MARGINTALK_PRIVATE_CONFIG_PATH,
  process.env.MARGINTALK_PRIVATE_DATABASE_PATH
].filter((path): path is string => Boolean(path)).map((path) => normalizePath(resolve(path)));

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    strictPort: true,
    fs: {
      strict: true,
      deny: [
        '**/.env', '**/.env.*', '**/*.{crt,pem}', '**/.git/**',
        '**/*.toml', '**/*.sqlite', '**/*.sqlite-*', '**/*.db', '**/*.db-*',
        ...['server', 'data', 'tests', 'e2e', 'scripts'].map((path) => `${normalizePath(resolve(path))}/**`),
        normalizePath(resolve('index.ts')),
        normalizePath(resolve('runtime.ts')),
        ...privatePaths,
        ...privatePaths.map((path) => `${path}-*`)
      ]
    },
    proxy: {
      '/api': { target, changeOrigin: false },
      '/auth': { target, changeOrigin: false }
    }
  }
});
