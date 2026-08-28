import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7430',
      '/artifacts': 'http://127.0.0.1:7430',
      '/trace-viewer': 'http://127.0.0.1:7430',
      '/ws': { target: 'ws://127.0.0.1:7430', ws: true },
    },
  },
});
