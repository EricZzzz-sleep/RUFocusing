import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { fs: { allow: ['../..'] } },
  test: { environment: 'node', include: ['tests/**/*.test.{ts,tsx}'] },
})
