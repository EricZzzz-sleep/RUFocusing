import { defineConfig } from 'vite'
// MediaPipe's WASM loader uses importScripts. Bundle one classic worker for both dev and production.
export default defineConfig({ publicDir: false, build: { outDir: 'public/tracking', emptyOutDir: true,
  lib: { entry: 'src/camera.worker.ts', name: 'RUFocusingCamera', formats: ['iife'], fileName: () => 'camera.js' },
} })
