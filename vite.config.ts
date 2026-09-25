/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './', // relative asset URLs: dist/ works from any path (GitHub Pages subpath, local file server)
  plugins: [react()],
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 800 }, // three.js is one lazy ~740 kB chunk
  optimizeDeps: { include: ['clipper2-ts', 'd3-delaunay'] }, // used only by the worker, found too late otherwise (page reload)
  test: { include: ['src/**/*.test.{ts,tsx}'] },
})
