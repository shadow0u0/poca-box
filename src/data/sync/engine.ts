import type { Firestore } from 'firebase/firestore';
import { ENTITY_TABLES, db, type EntityTableName } from '../db';
import type { BaseEntity, ID } from '../types';
import { getFirebase } from './firebase';
import { dedupeTaxonomies } from '../dedupe';
import { SYNC_LAST_PULLED_KEY } from '../hooks';
import { suppressLocalWrites, watchLocalWrites } from './localWrites';
import { seedIfNeeded } from '../seed';
import { reportPhotoSyncError, resetPhotoSyncState, syncPhotos } from './photos';

/**
 * Metadata sync: local IndexedDB ⇄ Firestore, one document per row.
 *
 * Rows already carry everything sync needs — a UUID, `updatedAt`, and a
 * soft-delete flag — so the cloud copy is the local row verbatim rather than a
 * separate schema.
 *
 * **Pending pushes come from a watermark, not a queue.** Anything with
 * `updatedAt` newer than the last successful push has not been sent yet,
 * including edits made offline. That is why there is no outbox table: the
 * information is already in the rows and already indexed, and a queue would
 * have to be written from inside Dexie hooks whose transactions do not include
 * it. The watermark only advances after a push fully succeeds, so a failure
 * mid-way simply resends next time — every write is idempotent.
 *
 * Photos are handled separately in `photos.ts` — their binaries live in R2, not
 * Firestore, and a remote row must never overwrite a local Blob. A card can
 * arrive before its image; the UI already renders a placeholder for one that is
 * missing.
 */

const LAST_PUSHED_KEY = 'syncLastPushedAt';
const LAST_PULLED_KEY = SYNC_LAST_PULLED_KEY;

/** Firestore rejects documents larger than 1 MiB; rows are far smaller. */
const BATCH_SIZE = 400;

export interface SyncResult {
  pushed: number;
  pulled: number;
  finishedAt: string;
}

export type SyncStatus =
  | { state: 'idle'; last?: SyncResult }
  | { state: 'syncing' }
  | { state: 'offline' }
  | { state: 'error'; message: string };

type Listener = (status: SyncStatus) => void;

let status: SyncStatus = { state: 'idle' };
const listeners = new Set<Listener>();

function setStatus(next: SyncStatus) {
  status = next;
  for (const l of listeners) l(next);
}

export function getSyncStatus(): SyncStatus {
  return status;
}

export function onSyncStatus(listener: Listener): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

function tableOf(name: EntityTableName) {
  return db[name] as unknown as import('dexie').Table<BaseEntity, ID>;
}

let firestorePromise: Promise<Firestore> | null = null;

async function firestore(): Promise<Firestore> {
  firestorePromise ??= (async () => {
    const { app } = await getFirebase();
    const { initializeFirestore, connectFirestoreEmulator } = await import('firebase/firestore');
    // Rows have optional fields that are genuinely `undefined`; without this
    // Firestore throws instead of simply omitting them.
    const fs = initializeFirestore(app, { ignoreUndefinedProperties: true });

    // Automated tests point the app at a local emulator. Guarded on an explicit
    // global so a production build can never be redirected by accident.
    const emulator = (globalThis as { __POCABOX_FIRESTORE_EMULATOR__?: string })
      .__POCABOX_FIRESTORE_EMULATOR__;
    if (emulator) {
      const [host, port] = emulator.split(':');
      connectFirestoreEmulator(fs, host, Number(port));
    }
    return fs;
  })();
  return firestorePromise;
}

async function readWatermark(key: string): Promise<string> {
  const row = await db.settings.get(key);
  return typeof row?.value === 'string' ? row.value : '';
}

/** Send every row changed since the last successful push. */
async function push(fs: Firestore, uid: string): Promise<number> {
  const { doc, writeBatch } = await import('firebase/firestore');
  const since = await readWatermark(LAST_PUSHED_KEY);
  // Captured before reading rows: anything written *during* the push keeps a
  // newer timestamp and is picked up next time rather than being skipped.
  const startedAt = new Date().toISOString();

  let sent = 0;
  for (const table of ENTITY_TABLES) {
    const rows = since
      ? await tableOf(table).where('updatedAt').above(since).toArray()
      : await tableOf(table).toArray();

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = writeBatch(fs);
      for (const row of rows.slice(i, i + BATCH_SIZE)) {
        batch.set(doc(fs, `users/${uid}/${table}/${row.id}`), row);
      }
      await batch.commit();
      sent += Math.min(BATCH_SIZE, rows.length - i);
    }
  }

  // Only after everything landed — a partial push must be retried in full.
  await db.settings.put({ key: LAST_PUSHED_KEY, value: startedAt });
  return sent;
}

/** Fetch rows changed since the last pull and merge them in. */
async function pull(fs: Firestore, uid: string): Promise<number> {
  const { collection, getDocs, query, where } = await import('firebase/firestore');
  const since = await readWatermark(LAST_PULLED_KEY);

  let applied = 0;
  let newest = since;

  for (const table of ENTITY_TABLES) {
    const ref = collection(fs, `users/${uid}/${table}`);
    // `>=` rather than `>`: two rows can share a millisecond, and re-reading a
    // row is free because the merge below is idempotent.
    const snap = await getDocs(since ? query(ref, where('updatedAt', '>=', since)) : query(ref));
    if (snap.empty) continue;

    const remote = snap.docs.map((d) => d.data() as BaseEntity);
    await db.transaction('rw', tableOf(table), async () => {
      for (const row of remote) {
        if (typeof row?.id !== 'string' || typeof row.updatedAt !== 'string') continue;
        if (row.updatedAt > newest) newest = row.updatedAt;
        const local = await tableOf(table).get(row.id);
        // Last write wins, and a tie leaves local alone.
        if (local && local.updatedAt >= row.updatedAt) continue;
        await tableOf(table).put(row);
        applied += 1;
      }
    });
  }

  if (newest) await db.settings.put({ key: LAST_PULLED_KEY, value: newest });
  return applied;
}

let inFlight: Promise<SyncResult | null> | null = null;

/**
 * Run one sync round. Concurrent callers share the in-flight run rather than
 * stacking up — auto-sync fires from several triggers at once.
 */
export function syncNow(uid: string): Promise<SyncResult | null> {
  if (inFlight) return inFlight;

  const run = (async (): Promise<SyncResult | null> => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setStatus({ state: 'offline' });
      return null;
    }
    setStatus({ state: 'syncing' });
    try {
      const fs = await firestore();
      const pushed = await push(fs, uid);
      // Everything from here writes rows this device did not author, so it must
      // not read as a local edit. Not a runaway risk — `pull` skips rows that
      // are not newer, so a second pass writes nothing and the cascade stops by
      // itself (measured: same number of rounds either way). This just avoids
      // the redundant round.
      const pulled = await suppressLocalWrites(() => pull(fs, uid));

      // The pull can bring in a second copy of a classification this device
      // already has — devices used to seed the defaults with their own random
      // ids. Collapsing them here, then pushing again, means the cleanup and
      // its tombstones land in the same round instead of a minute later.
      // Deferred from startup when this device had never pulled: the defaults
      // must not be created until we know whether this account already has a
      // set of classifications, or a name the user renamed away would come back
      // as a second entry. Seeding is a no-op once any rows exist.
      await seedIfNeeded();

      const { merged } = await suppressLocalWrites(() => dedupeTaxonomies());
      const cleaned = merged > 0 ? await push(fs, uid) : 0;

      const result: SyncResult = {
        pushed: pushed + cleaned,
        pulled,
        finishedAt: new Date().toISOString(),
      };
      setStatus({ state: 'idle', last: result });

      // Photos run after the text, and their failures stay their own: an
      // unreachable photo Worker must not make the card data look unsynced when
      // it is safely in Firestore. The photo row in 設定 reports the problem.
      try {
        await suppressLocalWrites(() => syncPhotos(fs, uid));
      } catch (photoError) {
        console.error('photo sync failed', photoError);
        reportPhotoSyncError(photoError);
      }

      return result;
    } catch (e) {
      console.error('sync failed', e);
      const code = (e as { code?: string }).code;
      setStatus({
        state: 'error',
        message:
          code === 'permission-denied'
            ? '雲端拒絕存取，請確認 Firestore 安全規則已發布。'
            : '同步失敗，稍後會自動重試。',
      });
      return null;
    }
  })();

  // Cleared from a `.finally` callback rather than inside the body. The offline
  // branch returns before its first `await`, so a `finally` block inside the
  // async function would run *before* the assignment below and leave a resolved
  // promise stuck here forever — one offline moment would kill sync for the
  // rest of the session. The identity check keeps a newer run from being
  // cleared by an older one finishing late.
  inFlight = run;
  void run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return run;
}

/**
 * Keep syncing in the background while signed in.
 *
 * Triggers on start, when the tab becomes visible again, when connectivity
 * returns, and on a slow interval as a backstop. Returns a stop function.
 */
/**
 * How long to wait after an edit before pushing it.
 *
 * Long enough that saving a card — which writes the card and both photos —
 * becomes one round rather than three, short enough that walking to another
 * device is never a race.
 */
const LOCAL_WRITE_DEBOUNCE_MS = 1_500;

export function startAutoSync(uid: string, intervalMs = 60_000): () => void {
  const run = () => void syncNow(uid);

  // An edit on this device syncs within seconds instead of waiting out the
  // interval. The interval stays as the safety net that catches everything
  // else: changes made on *other* devices, and anything a missed event dropped.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const stopWatching = watchLocalWrites(() => {
    clearTimeout(debounce);
    debounce = setTimeout(run, LOCAL_WRITE_DEBOUNCE_MS);
  });

  run();
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') run();
  }, intervalMs);
  const onVisible = () => {
    if (document.visibilityState === 'visible') run();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', run);

  // `pageshow` and `focus` as well as visibilitychange: an installed iOS app
  // coming back from the app switcher is often restored from the back/forward
  // cache, where `pageshow` fires and `visibilitychange` may not. Belt and
  // braces — `syncNow` collapses overlapping rounds, so extra triggers cost
  // nothing.
  window.addEventListener('pageshow', onVisible);
  window.addEventListener('focus', onVisible);

  return () => {
    clearTimeout(debounce);
    stopWatching();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', run);
    window.removeEventListener('pageshow', onVisible);
    window.removeEventListener('focus', onVisible);
  };
}

/** Forget both watermarks so the next sync reconciles everything. */
export async function resetSyncState(): Promise<void> {
  await db.settings.delete(LAST_PUSHED_KEY);
  await db.settings.delete(LAST_PULLED_KEY);
  await resetPhotoSyncState();
}
