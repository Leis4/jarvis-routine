// @ts-check
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:8765',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'iPhone WebKit',
      use: {
        ...devices['iPhone 14 Pro Max'],
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
    },
  ],
  webServer: {
    command: 'python -m http.server 8765 --directory site',
    url: 'http://localhost:8765',
    reuseExistingServer: !process.env.CI,
    timeout: 10000,
  },
});