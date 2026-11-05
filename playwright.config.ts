import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.playwright.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: process.env.FLOWKIT_DEMO_URL ?? 'http://localhost:3012',
    trace: 'retain-on-failure',
  },
});
