import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [
    react(),
    basicSsl(), // generates a self-signed cert so getUserMedia works on mobile
  ],
  server: {
    host: true,   // listen on 0.0.0.0 so mobile can reach it
    https: true,  // required for getUserMedia on non-localhost origins
    proxy: {
      // Forward Socket.io traffic to the Python signaling server
      '/socket.io': {
        target: 'http://localhost:5000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
