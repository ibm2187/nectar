import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Swallow EPIPE errors from the Vite dev server's WebSocket proxy.
// These happen when the backend restarts while the client is connected —
// harmless but extremely noisy in the terminal.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') return
  throw err
})

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        configure: (proxy) => {
          proxy.on('error', () => {})
        },
      },
      '/ws': {
        target: 'ws://localhost:4000',
        ws: true,
        configure: (proxy) => {
          proxy.on('error', () => {})
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.on('error', () => {})
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
