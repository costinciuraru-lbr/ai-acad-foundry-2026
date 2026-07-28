import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Where the backend lives depends on where THIS dev server is running, so compose
// sets VITE_API_TARGET per lane and the default covers plain `npm run dev`:
//   host          → http://localhost:7799            (the default below)
//   all in Docker → http://api:7799                  (docker-compose.yml)
//   API on host   → http://host.docker.internal:7799 (docker-compose.host-api.yml,
//                    which also needs uvicorn started with --host 0.0.0.0)
const target = process.env.VITE_API_TARGET || 'http://localhost:7799'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 7800,
    host: '0.0.0.0',
    watch: { usePolling: true },      // reliable file watching inside containers
    proxy: {
      // every backend route the console uses, proxied to avoid CORS entirely
      '/health': target,
      '/config': target,
      '/azure': target,
      '/chunk': target,
      '/ingest': target,
      '/collection': target,
      '/search': target,
      '/ask': target,
      '/agents': target,
      '/tools': target,
    },
  },
})
