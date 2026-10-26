import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1360, height: 860 }
  },
  webServer: {
    command: 'bun scripts/e2e-server.ts',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false
  }
});
