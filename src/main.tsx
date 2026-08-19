import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createHashRouter } from 'react-router-dom';
import App from './App';
import { routes } from './routes';
import { requestPersistentStorage, seedIfNeeded } from './data/seed';
import { runDataUpgrade } from './data/upgrade';
import { repo } from './data/repo';
import { SYNC_ENABLED_KEY, SYNC_LAST_PULLED_KEY } from './data/hooks';
import { dedupeTaxonomies } from './data/dedupe';
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
  // Signing in with a password is a test-only path — the real UI offers Google
  // and nothing else — but it is the only way to drive a genuine signed-in
  // session, which is exactly the link a uid override would skip over.
  const signInForTests = async (email: string, password: string) => {
    const { getFirebase } = await import('./data/sync/firebase');
    const { auth } = await getFirebase();
    const fb = await import('firebase/auth');
    try {
      await fb.signInWithEmailAndPassword(auth, email, password);
    } catch {
      await fb.createUserWithEmailAndPassword(auth, email, password);
    }
    return auth.currentUser?.uid ?? null;
  };

  Object.assign(globalThis, {
    __pocabox: {
      signInForTests,
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

  // A device that is signed in but has never pulled is joining a library that
  // already exists. Seeding it now would create defaults the account may have
  // renamed or deleted long ago, and those come back as extra entries rather
  // than merging — the names no longer match anything. The first sync round
  // seeds instead, by which point `seedIfNeeded` can see the pulled rows and
  // correctly does nothing. Offline is the exception: sync may not happen for a
  // while and an empty app helps nobody, so seed and let the dedupe pass tidy
  // up afterwards.
  const joiningExistingAccount =
    (await repo.settings.get(SYNC_ENABLED_KEY, false)) &&
    !(await repo.settings.get(SYNC_LAST_PULLED_KEY, '')) &&
    navigator.onLine;
  if (!joiningExistingAccount) await seedIfNeeded();
  // Also runs after every sync pull; here it covers a device that is offline,
  // or signed out, but still carrying duplicates from before the fix.
  const deduped = await dedupeTaxonomies();
  if (deduped.merged > 0) {
    console.info(`合併了 ${deduped.merged} 個重複的分類，${deduped.repointed} 張小卡已改指向保留的那一個`);
  }
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
