import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.RUFOCUSING_API_PORT || '18765'}`, changeOrigin: true } },
  },
})
