import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Relative asset paths, so the same build works at any deployment prefix —
// https://<user>.github.io/<repo>/ regardless of what the repo is called, and a
// domain root too. Renaming the repository cannot break the site this way.
const base = process.env.BASE_PATH ?? './';

/**
 * A build stamp shown in 設定.
 *
 * "Am I running the new version yet?" has cost two rounds of debugging on real
 * devices: a service worker can serve a build from days ago, and neither the UI
 * copy nor the behaviour reliably distinguishes one release from the next. A
 * commit and a timestamp on screen turns that into a glance.
 */
function buildId(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // Building outside a git checkout — fall back to something still unique.
    return new Date().toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * Semantic version from package.json, the single place it is edited.
 *
 * MAJOR: stored data changes shape in a way older builds cannot read, or the
 * app is redesigned. MINOR: a new capability. PATCH: fixes only.
 */
const appVersion: string = JSON.parse(readFileSync('./package.json', 'utf8')).version;

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_ID__: JSON.stringify(buildId()),
  },
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
        // The auth-*.html pages are throwaway diagnostics that get edited and
        // redeployed while testing. Precaching them would serve a stale copy from
        // the service worker and make a fixed page still look broken.
        globIgnores: ['**/auth-probe.html', '**/auth-cold.html'],
        // ...but excluding it from the precache is not enough on its own. The
        // generated worker routes *every* navigation to the app's index.html
        // (createHandlerBoundToURL("index.html")), so a non-precached page ends
        // up rendering the app instead of itself. Any standalone page added to
        // public/ needs an entry here, or it will silently serve the SPA.
        navigateFallbackDenylist: [/auth-(probe|cold)\.html$/],
        // Photos live in IndexedDB, never fetched over the network, so nothing
        // here needs a runtime caching strategy — the app shell is all there is.
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
});
