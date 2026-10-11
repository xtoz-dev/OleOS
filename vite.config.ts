import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = Number(env.API_PORT || 3001)
  return {
    plugins: [react()],
    server: {
      port: Number(env.VITE_PORT || 5173),
      proxy: {
        '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false },
        '/socket.io': { target: `http://localhost:${apiPort}`, changeOrigin: false, ws: true },
      },
    },
  }
})



