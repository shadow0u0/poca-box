import type { Firestore } from 'firebase/firestore';
import { ENTITY_TABLES, db, type EntityTableName } from '../db';
import type { BaseEntity, ID } from '../types';
import { getFirestore } from './firebase';
import { dedupeTaxonomies } from '../dedupe';
import {
  SYNC_ENABLED_KEY,
  SYNC_LAST_OK_KEY,
  SYNC_LAST_UID_KEY,
  SYNC_LAST_PULLED_KEY,
} from '../hooks';
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

/**
 * One tiny document every device watches, stamped whenever any of them pushes.
 *
 * Listening to the nine collections directly would mean nine initial snapshots
 * on every launch and nine subscriptions to keep; one document costs a single
 * read to attach and nothing at all while the library is untouched. The
 * listener only says *that* something changed — the ordinary pull is still what
 * fetches and merges it, so there is one path applying remote data, not two.
 */
const pulsePath = (uid: string) => `users/${uid}/meta/pulse`;

export interface SyncResult {
  pushed: number;
  pulled: number;
  finishedAt: string;
}

export type SyncStatus =
  | { state: 'idle'; last?: SyncResult }
  | { state: 'syncing' }
  | { state: 'offline' }
  /**
   * A different account signed in on a device that still holds someone else's
   * collection. Nothing is pushed or pulled until the person says which they
   * meant — see `resolveAccountChange`.
   */
  | { state: 'account-changed'; previousUid: string; uid: string }
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

// Moved to firebase.ts so photo cleanup can reach Firestore too — it can only
// be initialised once per app, so it cannot be owned by one module.
const firestore = getFirestore;

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

/**
 * The tables `seedIfNeeded` writes to.
 *
 * Small by nature — tens of rows between them — which is what makes sending
 * them whole an acceptable answer to the watermark problem below.
 */
const SEEDED_TABLES: EntityTableName[] = ['sources', 'cardTypes', 'statuses'];

/**
 * Send every row of the named tables, watermark or not.
 *
 * Needed because seeded rows carry a year-2000 timestamp — deliberate, so
 * seeding loses every merge it takes part in — which also puts them permanently
 * behind the push watermark. A default added by a later release would otherwise
 * exist on each device and never in the cloud. Re-sending a handful of rows
 * costs one batch and is idempotent, so it does not need to be clever.
 *
 * The watermark is left alone: this is an extra send, not a checkpoint.
 */
async function pushWholeTables(
  fs: Firestore,
  uid: string,
  tables: EntityTableName[],
): Promise<number> {
  const { doc, writeBatch } = await import('firebase/firestore');

  let sent = 0;
  for (const table of tables) {
    const rows = await tableOf(table).toArray();
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = writeBatch(fs);
      for (const row of rows.slice(i, i + BATCH_SIZE)) {
        batch.set(doc(fs, `users/${uid}/${table}/${row.id}`), row);
      }
      await batch.commit();
      sent += Math.min(BATCH_SIZE, rows.length - i);
    }
  }
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

/**
 * Turn a Firestore failure into something a person can act on.
 *
 * Only the codes that can genuinely happen to this app are named. Everything
 * else keeps the honest generic message rather than a guess: sync retries by
 * itself, and the staleness warning in 設定 is what stops an unnamed failure
 * from going unnoticed indefinitely.
 */
export function describeSyncError(e: unknown): string {
  switch ((e as { code?: string }).code) {
    case 'permission-denied':
      return '雲端拒絕存取，請確認 Firestore 安全規則已發布。';
    case 'unauthenticated':
      return '登入已過期，請到下方重新登入一次。';
    case 'resource-exhausted':
      // Firestore's free tier resets daily. Worth saying, because the obvious
      // reading of a quota error — that something is broken — is wrong.
      return '今天的雲端免費額度用完了，明天會自動恢復；資料仍安全留在這台裝置。';
    case 'unavailable':
    case 'deadline-exceeded':
      return '連不上雲端，稍後會自動重試。';
    default:
      return '同步失敗，稍後會自動重試。';
  }
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
    // Before anything is sent anywhere: is this the account whose collection is
    // sitting in this database? Signing out keeps the data anyway — someone
    // pausing sync would be appalled to lose it — so a device can be holding one
    // person's library while a second person signs in. Pushing here would put
    // the first person's collection in the second person's account, and pull
    // theirs down on top. Both are silent and neither is undoable, so this stops
    // and asks instead.
    const previousUid = await readWatermark(SYNC_LAST_UID_KEY);
    if (previousUid && previousUid !== uid) {
      setStatus({ state: 'account-changed', previousUid, uid });
      return null;
    }

    setStatus({ state: 'syncing' });
    try {
      const fs = await firestore();
      // Claim the device for this account *before* the first push. Recording it
      // afterwards would leave a failed first round looking like a fresh device
      // on the retry, which is exactly when the collection would leak.
      if (!previousUid) await db.settings.put({ key: SYNC_LAST_UID_KEY, value: uid });
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
      const seeded = await seedIfNeeded();

      const { merged } = await suppressLocalWrites(() => dedupeTaxonomies());
      // Dedupe stamps its tombstones and repointed cards with the current time,
      // so the ordinary watermark push picks them up.
      let cleaned = merged > 0 ? await push(fs, uid) : 0;
      // Seeding cannot be caught that way. Its rows carry year 2000 — deliberate,
      // so seeding always loses a merge — which also places them permanently
      // behind the push watermark, leaving a default added by a later release
      // stranded on each device. Sending the three tables outright is the fix
      // and costs nothing: they hold tens of rows, not thousands.
      if (seeded > 0) cleaned += await pushWholeTables(fs, uid, SEEDED_TABLES);

      // Tell the other devices, but only when there was actually something to
      // tell them about — a round that sent nothing must not wake anyone.
      if (pushed + cleaned > 0) {
        const { doc, setDoc } = await import('firebase/firestore');
        await setDoc(doc(fs, pulsePath(uid)), { at: new Date().toISOString() });
      }

      const result: SyncResult = {
        pushed: pushed + cleaned,
        pulled,
        finishedAt: new Date().toISOString(),
      };
      setStatus({ state: 'idle', last: result });
      await db.settings.put({ key: SYNC_LAST_OK_KEY, value: result.finishedAt });

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
      setStatus({ state: 'error', message: describeSyncError(e) });
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

/**
 * Backstop only, now that a listener delivers other devices' changes as they
 * happen. It used to be the *sole* way to learn about them, at 60 seconds.
 *
 * That was expensive in a way that is easy to miss: Firestore bills a minimum
 * of one read per query even when the query matches nothing, and a round issues
 * ten. A tab left open all day cost roughly 14,000 reads against a 50,000 free
 * daily allowance while reporting no changes whatsoever. Every one of those is
 * now avoided; this fires only to recover from a dropped listener.
 */
const BACKSTOP_INTERVAL_MS = 15 * 60_000;

/** Wake on someone else's push. Returns an unsubscribe. */
async function watchRemoteChanges(uid: string, onChange: () => void): Promise<() => void> {
  const fs = await firestore();
  const { doc, onSnapshot } = await import('firebase/firestore');
  return onSnapshot(
    doc(fs, pulsePath(uid)),
    (snap) => {
      // Skip this device's own stamp echoing back before the server confirms
      // it; that change is already applied here.
      if (snap.metadata.hasPendingWrites) return;
      onChange();
    },
    (e) => console.error('remote change listener failed', e),
  );
}

export function startAutoSync(uid: string, intervalMs = BACKSTOP_INTERVAL_MS): () => void {
  const run = () => void syncNow(uid);

  // An edit on this device syncs within seconds instead of waiting out the
  // interval.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const stopWatching = watchLocalWrites(() => {
    clearTimeout(debounce);
    debounce = setTimeout(run, LOCAL_WRITE_DEBOUNCE_MS);
  });

  // And an edit on *another* device arrives here as it happens, rather than
  // whenever this one next got round to asking.
  let stopListening: (() => void) | undefined;
  let listenerCancelled = false;
  void watchRemoteChanges(uid, run).then((off) => {
    // The subscription is asynchronous; if sync stopped while it was being set
    // up, tear it down immediately rather than leaking it.
    if (listenerCancelled) off();
    else stopListening = off;
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
    listenerCancelled = true;
    stopListening?.();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', run);
    window.removeEventListener('pageshow', onVisible);
    window.removeEventListener('focus', onVisible);
  };
}

/**
 * Forget both watermarks so the next sync reconciles everything.
 *
 * Deliberately keeps `SYNC_LAST_UID_KEY`: signing out is the moment a device
 * most often changes hands, and forgetting who was here is precisely what would
 * let the next account absorb this one's collection unnoticed.
 */
export async function resetSyncState(): Promise<void> {
  await db.settings.delete(LAST_PUSHED_KEY);
  await db.settings.delete(LAST_PULLED_KEY);
  await resetPhotoSyncState();
  // The status is module state, so it outlives the settings page. Left alone,
  // an unanswered `account-changed` would still be sitting there and would
  // flash back into view the moment anyone signed in again.
  setStatus({ state: 'idle' });
}

export type AccountChangeChoice = 'replace' | 'merge';

/**
 * Answer the question raised by `state: 'account-changed'` and sync.
 *
 * `replace` is for a device that changed hands: the local collection is dropped
 * and the new account's is downloaded. It uses `clearAllData`, which deletes
 * outright rather than writing tombstones, so **neither account's cloud copy is
 * touched** — the previous owner keeps everything on their other devices.
 *
 * `merge` is the old behaviour, now only ever reached deliberately: someone
 * with two accounts of their own who wants the two libraries combined.
 */
export async function resolveAccountChange(
  uid: string,
  choice: AccountChangeChoice,
): Promise<void> {
  if (choice === 'replace') {
    const { clearAllData } = await import('../backup');
    await suppressLocalWrites(async () => {
      await clearAllData();
      await resetPhotoSyncState();
    });
    // `clearAllData` empties `settings` too, so the opt-in has to be written
    // back or sync would switch itself off as a side effect of this choice.
    await db.settings.put({ key: SYNC_ENABLED_KEY, value: true });
  } else {
    await db.settings.delete(LAST_PUSHED_KEY);
    await db.settings.delete(LAST_PULLED_KEY);
  }

  await db.settings.put({ key: SYNC_LAST_UID_KEY, value: uid });
  setStatus({ state: 'idle' });
  await syncNow(uid);
}
