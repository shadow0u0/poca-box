import type { Firestore } from 'firebase/firestore';
import { ENTITY_TABLES, db, type EntityTableName } from '../db';
import type { BaseEntity, ID } from '../types';
import { getFirebase } from './firebase';
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
const LAST_PULLED_KEY = 'syncLastPulledAt';

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
      const pulled = await pull(fs, uid);
      const result: SyncResult = { pushed, pulled, finishedAt: new Date().toISOString() };
      setStatus({ state: 'idle', last: result });

      // Photos run after the text, and their failures stay their own: an
      // unreachable photo Worker must not make the card data look unsynced when
      // it is safely in Firestore. The photo row in 設定 reports the problem.
      try {
        await syncPhotos(fs, uid);
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
export function startAutoSync(uid: string, intervalMs = 60_000): () => void {
  const run = () => void syncNow(uid);

  run();
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') run();
  }, intervalMs);
  const onVisible = () => {
    if (document.visibilityState === 'visible') run();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', run);

  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', run);
  };
}

/** Forget both watermarks so the next sync reconciles everything. */
export async function resetSyncState(): Promise<void> {
  await db.settings.delete(LAST_PUSHED_KEY);
  await db.settings.delete(LAST_PULLED_KEY);
  await resetPhotoSyncState();
}
