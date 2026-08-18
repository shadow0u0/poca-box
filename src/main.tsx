import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createHashRouter } from 'react-router-dom';
import App from './App';
import { routes } from './routes';
import { requestPersistentStorage, seedIfNeeded } from './data/seed';
import { runDataUpgrade } from './data/upgrade';
import './index.css';

// Hash routing keeps deep links working on GitHub Pages, which serves static
// files only and cannot rewrite unknown paths to index.html.
const router = createHashRouter([{ path: '/', element: <App />, children: routes }]);

/**
 * Automated sync tests need to drive the engine directly. Exposed only when the
 * emulator global is present, which a production build never sets, so this is
 * inert outside the test harness.
 */
async function exposeSyncForTests() {
  if (!(globalThis as { __POCABOX_FIRESTORE_EMULATOR__?: string }).__POCABOX_FIRESTORE_EMULATOR__) {
    return;
  }
  const [engine, photoSync, { repo }, { db }] = await Promise.all([
    import('./data/sync/engine'),
    import('./data/sync/photos'),
    import('./data/repo'),
    import('./data/db'),
  ]);
  Object.assign(globalThis, {
    __pocabox: {
      syncNow: engine.syncNow,
      resetSyncState: engine.resetSyncState,
      getSyncStatus: engine.getSyncStatus,
      fillFullImages: photoSync.fillFullImages,
      getPhotoSyncState: photoSync.getPhotoSyncState,
      planCloudCleanup: photoSync.planCloudCleanup,
      deleteCloudPhotos: photoSync.deleteCloudPhotos,
      repo,
      db,
    },
  });
}

async function bootstrap() {
  // Migrate stored rows to the current format before anything reads them, and
  // before seeding adds new ones. Logged so a support question can be answered
  // from the console rather than guesswork.
  const upgrade = await runDataUpgrade();
  if (upgrade.kind === 'migrated') {
    console.info(`資料已從 v${upgrade.from} 升級到 v${upgrade.to}`, upgrade.applied);
  } else if (upgrade.kind === 'from-future') {
    console.warn(
      `本機資料格式為 v${upgrade.stored}，此版本僅支援 v${upgrade.supported}；資料保持原狀未變更。`,
    );
  } else if (upgrade.kind === 'failed') {
    console.error('資料升級失敗，已保留升級前的快照：', upgrade.error);
  }

  await exposeSyncForTests();
  await seedIfNeeded();
  // Fire-and-forget: a refusal only means the browser may evict data later,
  // which 設定 surfaces as a banner.
  void requestPersistentStorage();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}

void bootstrap();
