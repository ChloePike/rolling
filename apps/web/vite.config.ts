import { fileURLToPath } from 'node:url';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
/** Where dev and preview proxy `/api` (the local Worker by default; e.g. a staging Worker URL for a manual look). */
const API_ORIGIN = process.env.ROLLING_API_ORIGIN ?? 'http://localhost:8787';

/**
 * Preloads the self-hosted Geist variable font from index.html, so it downloads alongside the
 * entry script instead of after the stylesheet is parsed. The server turns this `<link>` into a
 * `Link` header for 103 Early Hints (scripts/early-hints.mjs, apps/api/src/lib/r2Static.ts).
 */
function preloadMainFont(): Plugin {
  return {
    name: 'rolling:preload-main-font',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const font = Object.keys(ctx.bundle ?? {}).find((f) => /(^|\/)Geist-Variable-[\w-]+\.woff2$/.test(f));
        if (!font) return [];
        return [{ tag: 'link', attrs: { rel: 'preload', href: `/${font}`, as: 'font', type: 'font/woff2', crossorigin: true }, injectTo: 'head' }];
      },
    },
  };
}

export default defineConfig({
  plugins: [
    // Must run before the React plugin.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    preloadMainFont(),
    /*
     * PWA (handoff 8, PWA.dc.html). `injectManifest`, not `generateSW`: the
     * worker (src/sw.ts) is our own small file whose routes are explicit and
     * unit tested (lib/pwa/swRules.ts) — it must never touch /api, the
     * WebSocket, media hosts, R2 presigned uploads, Google sign-in or Stripe —
     * and it only activates a new version on the user's Reload (SKIP_WAITING
     * message), which generateSW's config can't express as directly.
     * Registration is ours too (lib/pwa/register.ts: prod builds only, mock
     * builds only when a test opts in), so `injectRegister: false`.
     */
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      manifestFilename: 'manifest.webmanifest',
      // Icons are listed in the manifest; the precache glob below covers them.
      includeManifestIcons: false,
      manifest: {
        id: '/',
        name: 'Rolling',
        short_name: 'Rolling',
        description: 'Video studio for creators and small brand teams.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        // PWA.dc.html: both #0B0B0C (--c-bg, dark). index.html keeps the theme-color meta on the active theme.
        theme_color: '#0B0B0C',
        background_color: '#0B0B0C',
        lang: 'en',
        dir: 'ltr',
        categories: ['productivity', 'photo'],
        icons: [
          { src: '/icons/app-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/app-icon-1024.png', sizes: '1024x1024', type: 'image/png', purpose: 'any' },
          { src: '/icons/app-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      injectManifest: {
        // iife: a classic worker script, registered without `type: 'module'` (every browser).
        rollupFormat: 'iife',
        // The plugin adds manifest.webmanifest itself.
        globPatterns: ['**/*.{js,css,html,woff2,svg,png}'],
        // Only the manifest needs the 1024 icon and the Google logo lives on the login page; fetched on demand.
        globIgnores: ['icons/app-icon-1024.png', 'icons/google-oauth-logo-*.png', 'sw.js'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@messages': r('../../messages'),
      '@legal': r('../../legal'),
      '@/': `${r('./src')}/`,
      // The geist package only exports Next.js helpers; point at its woff2 files to self-host them.
      '@geist-fonts': r('./node_modules/geist/dist/fonts/geist-sans'),
    },
  },
  // Transfer workers (D-011) are module workers and code-split like the app.
  worker: { format: 'es' },
  build: {
    // The Worker (apps/api) serves the SPA from here as static assets.
    outDir: r('./dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_ORIGIN, changeOrigin: true, ws: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: API_ORIGIN, changeOrigin: true, ws: true },
    },
  },
});
