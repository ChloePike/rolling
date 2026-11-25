import { fileURLToPath } from 'node:url';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    // Must run before the React plugin.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
  ],
  resolve: {
    alias: {
      '@messages': r('../../messages'),
      // The geist package only exports Next.js helpers; point at its woff2 files to self-host them.
      '@geist-fonts': r('./node_modules/geist/dist/fonts/geist-sans'),
    },
  },
  build: {
    // The Worker (apps/api) serves the SPA from here as static assets.
    outDir: r('./dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true, ws: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true, ws: true },
    },
  },
});
