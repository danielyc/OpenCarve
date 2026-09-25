import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://localhost:5173', reducedMotion: 'reduce' },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
  webServer: { command: 'bun run dev --strictPort', url: 'http://localhost:5173', reuseExistingServer: !process.env.CI },
})
