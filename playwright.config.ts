import { defineConfig } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: './tests', testMatch: '**/*.e2e.ts', workers: 1,
  use: {baseURL:'http://localhost:5173', browserName:'chromium', channel:'msedge', trace:'retain-on-failure'},
  outputDir:'work/test-results',
  webServer: {command:'npm run dev', url:'http://localhost:5173', reuseExistingServer:false, env:{DATA_DIR:path.resolve(`work/ui-test-data/${Date.now()}`)}, timeout:30000},
});
