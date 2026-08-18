import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Relative asset paths, so the same build works at any deployment prefix —
// https://<user>.github.io/<repo>/ regardless of what the repo is called, and a
// domain root too. Renaming the repository cannot break the site this way.
const base = process.env.BASE_PATH ?? './';

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon.svg'],
      manifest: {
        name: '小卡櫃 · K-pop 收藏管理',
        short_name: '小卡櫃',
        description: '整理、歸檔並記錄你的 K-pop 偶像小卡收藏。資料只存在你自己的裝置上。',
        lang: 'zh-Hant-TW',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f0d16',
        theme_color: '#0f0d16',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // auth-probe.html is a throwaway diagnostic page that gets edited and
        // redeployed while testing. Precaching it would serve a stale copy from
        // the service worker and make a fixed page still look broken.
        globIgnores: ['**/auth-probe.html'],
        // ...but excluding it from the precache is not enough on its own. The
        // generated worker routes *every* navigation to the app's index.html
        // (createHandlerBoundToURL("index.html")), so a non-precached page ends
        // up rendering the app instead of itself. Any standalone page added to
        // public/ needs an entry here, or it will silently serve the SPA.
        navigateFallbackDenylist: [/auth-probe\.html$/],
        // Photos live in IndexedDB, never fetched over the network, so nothing
        // here needs a runtime caching strategy — the app shell is all there is.
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
});
