import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://localhost:5173' },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
  webServer: { command: 'bun run dev', url: 'http://localhost:5173', reuseExistingServer: true },
})
