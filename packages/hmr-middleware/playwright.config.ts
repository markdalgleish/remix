import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.e2e.test.ts',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:44200',
    trace: 'on-first-retry',
  },
  webServer: {
    // Starts esbuild watch + HMR server in a single process
    // Properly cleans up both on exit
    command: 'pnpm run test:e2e:dev',
    url: 'http://localhost:44200',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
})
