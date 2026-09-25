/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: { include: ['clipper2-ts'] }, // used only by the worker, found too late otherwise (page reload)
  test: { include: ['src/**/*.test.{ts,tsx}'] },
})
